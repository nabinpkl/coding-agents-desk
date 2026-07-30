import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  acquireIndex,
  discardIndexIfUnused,
  ensureIndexed,
  getEventCount,
  niceInsertionPoint,
  readEventRaw,
  readEvents,
  releaseIndex,
  translateEventIndex,
} from "./eventIndex.ts";
import { state } from "./transcriptState.ts";
import { sessionKey } from "./transcriptCatalog.ts";

const roots: string[] = [];
const source = "codex" as const;
const sessionId = "11111111-1111-1111-1111-111111111111";

afterEach(async () => {
  state.sessions.clear();
  state.eventByteOffsets.clear();
  state.niceToRaw.clear();
  state.indexedSizes.clear();
  state.indexed.clear();
  state.indexBuilds.clear();
  state.indexReferences.clear();
  state.sessionUsage.clear();
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/**
 * A transcript where machinery and content are physically interleaved.
 *
 * The interleaving is the point: nice mode reads the byte span between two indexed
 * content lines, and the omitted lines sit inside that span. A page that returned
 * them, or that numbered rows by position in the span, would come back with indices
 * that address different lines than the ones it delivered.
 */
async function interleavedTranscript(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agent-feed-mode-"));
  roots.push(root);
  const transcriptPath = join(root, "rollout.jsonl");
  const lines: string[] = [];
  for (let turn = 0; turn < 12; turn++) {
    const at = `2026-01-01T00:00:${String(turn).padStart(2, "0")}Z`;
    lines.push(JSON.stringify({
      timestamp: at,
      type: "response_item",
      payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: `turn ${turn}` }] },
    }));
    // Two machinery lines per content line, the ratio the real corpus shows.
    lines.push(JSON.stringify({
      timestamp: at,
      type: "event_msg",
      payload: { type: "token_count", info: { last_token_usage: { total_tokens: 1_000 + turn } } },
    }));
    lines.push(JSON.stringify({
      timestamp: at,
      type: "response_item",
      payload: { type: "reasoning", summary: [], encrypted_content: `gAAAAAB${turn}` },
    }));
  }
  await writeFile(transcriptPath, `${lines.join("\n")}\n`);
  state.sessions.set(sessionKey(source, sessionId), {
    source,
    sessionId,
    project: root,
    transcriptPath,
    lastEventAt: Date.now(),
  });
  return transcriptPath;
}

test("builds an index only while acquired and releases it after the final owner", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-feed-index-"));
  roots.push(root);
  const transcriptPath = join(root, "rollout.jsonl");
  await writeFile(transcriptPath, [
    JSON.stringify({ timestamp: "2026-01-01T00:00:00Z", type: "event_msg", payload: { type: "task_started" } }),
    JSON.stringify({ timestamp: "2026-01-01T00:00:01Z", type: "event_msg", payload: { type: "task_complete" } }),
    "",
  ].join("\n"));
  state.sessions.set(sessionKey(source, sessionId), {
    source,
    sessionId,
    project: root,
    transcriptPath,
    lastEventAt: Date.now(),
  });

  acquireIndex(source, sessionId);
  await ensureIndexed(source, sessionId, transcriptPath);
  expect(getEventCount(source, sessionId)).toBe(2);
  expect((await readEvents(source, sessionId, transcriptPath, 0, 10)).length).toBe(2);
  expect(await readEventRaw(source, sessionId, transcriptPath, 0)).toContain("task_started");
  discardIndexIfUnused(source, sessionId);
  expect(state.eventByteOffsets.has(sessionKey(source, sessionId))).toBe(true);
  releaseIndex(source, sessionId);
  expect(state.eventByteOffsets.has(sessionKey(source, sessionId))).toBe(false);
});

describe("nice mode", () => {
  test("counts and pages only content lines", async () => {
    const transcriptPath = await interleavedTranscript();
    acquireIndex(source, sessionId);
    await ensureIndexed(source, sessionId, transcriptPath);

    expect(getEventCount(source, sessionId)).toBe(36);
    expect(getEventCount(source, sessionId, "nice")).toBe(12);

    const page = await readEvents(source, sessionId, transcriptPath, 0, 100, "nice");
    expect(page.map((event) => event.index)).toEqual([...Array(12).keys()]);
    // Renumbered contiguously, and every row is the prose, not a token count.
    expect(page.map((event) => event.blocks[0]?.text)).toEqual(
      [...Array(12).keys()].map((turn) => `turn ${turn}`),
    );
    releaseIndex(source, sessionId);
  });

  test("every index a page returns resolves to the line it delivered", async () => {
    const transcriptPath = await interleavedTranscript();
    acquireIndex(source, sessionId);
    await ensureIndexed(source, sessionId, transcriptPath);

    // The failure this guards is silent: if `readEvents` numbered rows by their
    // position in the byte span rather than re-applying the classification, the
    // page would look right and every Raw fetch, paging anchor and sticky jump
    // built on those indices would address a different line.
    for (const mode of ["raw", "nice"] as const) {
      const total = getEventCount(source, sessionId, mode);
      for (let offset = 0; offset < total; offset += 5) {
        const page = await readEvents(source, sessionId, transcriptPath, offset, 5, mode);
        for (const event of page) {
          const raw = await readEventRaw(
            source,
            sessionId,
            transcriptPath,
            event.index,
            mode,
          );
          expect(raw).not.toBeNull();
          const line = JSON.parse(raw!);
          const rendered = event.blocks[0]?.text ?? "";
          if (line.payload?.type === "message") {
            expect(rendered).toBe(line.payload.content[0].text);
          } else {
            // Only raw mode can land here at all; nice mode omits these entirely.
            expect(mode).toBe("raw");
          }
        }
      }
    }
    releaseIndex(source, sessionId);
  });

  test("pages carry the counterpart index so a mode switch keeps its place", async () => {
    const transcriptPath = await interleavedTranscript();
    acquireIndex(source, sessionId);
    await ensureIndexed(source, sessionId, transcriptPath);

    const nice = await readEvents(source, sessionId, transcriptPath, 4, 3, "nice");
    // Content lines sit at raw 0, 3, 6, ... so nice 4 is raw 12.
    expect(nice.map((event) => [event.index, event.otherModeIndex])).toEqual([
      [4, 12], [5, 15], [6, 18],
    ]);

    const raw = await readEvents(source, sessionId, transcriptPath, 12, 3, "raw");
    // Raw 13 and 14 are the machinery pair, which have no nice counterpart.
    expect(raw.map((event) => [event.index, event.otherModeIndex])).toEqual([
      [12, 4], [13, null], [14, null],
    ]);
    releaseIndex(source, sessionId);
  });

  test("translation is null in exactly one direction", async () => {
    const transcriptPath = await interleavedTranscript();
    acquireIndex(source, sessionId);
    await ensureIndexed(source, sessionId, transcriptPath);

    expect(translateEventIndex(source, sessionId, 4, "nice")).toBe(12);
    expect(translateEventIndex(source, sessionId, 12, "raw")).toBe(4);
    // A machinery row is absent from the nice view, so there is nothing to
    // translate to -- the caller decides what to do about that, not this.
    expect(translateEventIndex(source, sessionId, 13, "raw")).toBeNull();
    expect(translateEventIndex(source, sessionId, 999, "nice")).toBeNull();
    releaseIndex(source, sessionId);
  });
});

test("niceInsertionPoint finds the nearest content event at or after an index", () => {
  const niceToRaw = [0, 3, 6, 9];
  expect(niceInsertionPoint(niceToRaw, 0)).toBe(0);
  expect(niceInsertionPoint(niceToRaw, 1)).toBe(1);
  expect(niceInsertionPoint(niceToRaw, 3)).toBe(1);
  expect(niceInsertionPoint(niceToRaw, 9)).toBe(3);
  expect(niceInsertionPoint(niceToRaw, 10)).toBe(4);
  expect(niceInsertionPoint([], 5)).toBe(0);
});
