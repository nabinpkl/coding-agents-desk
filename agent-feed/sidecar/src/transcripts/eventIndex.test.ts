import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  acquireIndex,
  discardIndexIfUnused,
  ensureIndexed,
  followTranscript,
  getEventCount,
  niceInsertionPoint,
  readEventRaw,
  readEvents,
  releaseIndex,
  subscribeEvents,
  syncIndex,
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
  state.indexResyncs.clear();
  state.indexReferences.clear();
  state.sessionUsage.clear();
  for (const follow of state.transcriptFollows.values()) await (await follow.watcher).close();
  state.transcriptFollows.clear();
  await Promise.all(state.transcriptFollowClosing.values());
  state.transcriptFollowClosing.clear();
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
/** One content line, the shape the codex adapter turns into a visible event. */
function contentLine(turn: number): string {
  return JSON.stringify({
    timestamp: `2026-01-01T00:00:${String(turn % 60).padStart(2, "0")}Z`,
    type: "response_item",
    payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: `turn ${turn}` }] },
  });
}

async function interleavedTranscript(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agent-feed-mode-"));
  roots.push(root);
  const transcriptPath = join(root, "rollout.jsonl");
  const lines: string[] = [];
  for (let turn = 0; turn < 12; turn++) {
    const at = `2026-01-01T00:00:${String(turn).padStart(2, "0")}Z`;
    lines.push(contentLine(turn));
    // Two machinery lines per content line, the ratio the real corpus shows.
    // The token_count records carry per-turn cache data like the real harness,
    // so the cache-badge re-stamp is exercised by the interleaved reads.
    lines.push(JSON.stringify({
      timestamp: at,
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: 600 + turn,
            cached_input_tokens: 500 + turn,
            total_tokens: 1_000 + turn,
          },
        },
      },
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

  test("codex token_count re-stamps its cache badge onto the turn's last content row", async () => {
    const transcriptPath = await interleavedTranscript();
    acquireIndex(source, sessionId);
    await ensureIndexed(source, sessionId, transcriptPath);

    for (const mode of ["raw", "nice"] as const) {
      const page = await readEvents(source, sessionId, transcriptPath, 0, 100, mode);
      const content = page.filter((event) => event.blocks[0]?.kind === "text");
      expect(content.length).toBe(12);
      content.forEach((event, turn) => {
        // cached 500+turn of the full input 600+turn (input_tokens already
        // includes the cached portion).
        expect(event.cacheHit).toEqual({ cached: 500 + turn, input: 600 + turn });
      });
      const tokenRows = page.filter((event) => event.blocks[0]?.label === "Token Usage");
      if (mode === "raw") {
        // Raw renders the machinery row itself, and it carries the badge there
        // too; the nice view hides it and reads the text-row badge instead.
        expect(tokenRows.length).toBe(12);
        tokenRows.forEach((event, turn) => {
          expect(event.cacheHit).toEqual({ cached: 500 + turn, input: 600 + turn });
        });
      } else {
        expect(tokenRows.length).toBe(0);
      }
    }
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

describe("following a transcript", () => {
  test("readers of one transcript share a single watch and one index reference each", async () => {
    const transcriptPath = await interleavedTranscript();
    const key = sessionKey(source, sessionId);

    const releaseFirst = followTranscript(source, sessionId, transcriptPath, () => {});
    const releaseSecond = followTranscript(source, sessionId, transcriptPath, () => {});
    // Two agent windows on one thread: two readers, two index references, one watch.
    expect(state.transcriptFollows.size).toBe(1);
    expect(state.indexReferences.get(key)).toBe(2);

    releaseFirst();
    // The watch outlives the first reader, because the second is still reading.
    expect(state.transcriptFollows.size).toBe(1);
    expect(state.indexReferences.get(key)).toBe(1);
    // A release that runs twice must not take the surviving reader's slot with it.
    releaseFirst();
    expect(state.transcriptFollows.size).toBe(1);
    expect(state.indexReferences.get(key)).toBe(1);

    releaseSecond();
    expect(state.transcriptFollows.size).toBe(0);
    expect(state.indexReferences.has(key)).toBe(false);
  });

  test("a sync that joins a running build asks it for another pass", async () => {
    const transcriptPath = await interleavedTranscript();
    const key = sessionKey(source, sessionId);
    acquireIndex(source, sessionId);

    // The build promise is registered synchronously, so the second call below is
    // guaranteed to find it in flight. What it cannot assert deterministically is
    // that the extra pass READ new bytes -- the running pass measures the file after
    // any synchronous append this test could make, so it would cover them anyway.
    // What is pinned here is the mechanism: the join registers a request, and the
    // build consumes it rather than leaving it set for the next caller to inherit.
    const building = ensureIndexed(source, sessionId, transcriptPath);
    expect(state.indexBuilds.has(key)).toBe(true);
    const joining = syncIndex(source, sessionId, transcriptPath);
    expect(state.indexResyncs.has(key)).toBe(true);

    await Promise.all([building, joining]);
    expect(state.indexResyncs.has(key)).toBe(false);
    expect(state.indexBuilds.has(key)).toBe(false);
    expect(getEventCount(source, sessionId)).toBe(36);
    releaseIndex(source, sessionId);
  });
});

test("the last reader leaving mid-build does not silence the session's events", async () => {
  // Switching threads takes the refcount to zero and drops the index state -- including the
  // in-flight build's entry in `indexBuilds`, which is the only thing stopping a second build
  // for the same key. Two scans then push into one `eventByteOffsets` array, where
  // `emitParsedRaw`'s replay guard silently drops whichever is behind.
  //
  // This is reachable and worth pinning, but note what it does NOT do: because `dropIndexState`
  // clears all five maps together, both builds restart from zero and converge on the same
  // answer. That is why this passes on the code as written, and why it is a guard against
  // regression rather than a reproduction of the freeze -- whose mechanism is still open.
  const transcriptPath = await interleavedTranscript();
  const notices: number[] = [];
  const unsubscribe = subscribeEvents(source, sessionId, ({ event }) => notices.push(event.index));

  const unfollow = followTranscript(source, sessionId, transcriptPath, () => {});
  await ensureIndexed(source, sessionId, transcriptPath);
  await appendFile(transcriptPath, `${contentLine(100)}\n`);
  // The build is registered and suspended on its first await by the time this returns.
  const building = syncIndex(source, sessionId, transcriptPath);
  // The viewer switches threads. This is the last reference, so the state is dropped --
  // `indexBuilds` included, while that build is still running.
  unfollow();
  // The viewer comes back, or another surface opens the same thread. The dedupe gate is
  // gone, so this is a SECOND concurrent build over the same key and the same arrays.
  const refollow = followTranscript(source, sessionId, transcriptPath, () => {});
  const racing = ensureIndexed(source, sessionId, transcriptPath);
  await Promise.all([building, racing]);

  // Whatever happened above, the session must still deliver what is appended next.
  notices.length = 0;
  await appendFile(transcriptPath, `${contentLine(101)}\n${contentLine(102)}\n`);
  await syncIndex(source, sessionId, transcriptPath);

  expect(notices.length).toBe(2);
  unsubscribe();
  refollow();
});

test("a reader coming back waits for the leaving reader's watch to close", async () => {
  // The case this is about is ordinary, not exotic: a card toggled, a reader moving between two
  // cards on one session, a Vite reload. Each is a close and an open on one path with nothing
  // ordering them. What loses that race is not this follow -- every watch in the process shares
  // one watcher thread, and an open contending with a close is contending for the lock that
  // thread holds against the main thread. Measured once as a sidecar that answered its port and
  // nothing else, main thread parked in `_os_unfair_lock_lock_slow` for every sample.
  const transcriptPath = await interleavedTranscript();
  const key = sessionKey(source, sessionId);

  const release = followTranscript(source, sessionId, transcriptPath, () => {});
  await state.transcriptFollows.get(key)!.watcher;

  release();
  expect(state.transcriptFollowClosing.has(key)).toBe(true);

  const refollow = followTranscript(source, sessionId, transcriptPath, () => {});
  // Still closing, so the new watch is not open yet. Before this ordering existed the watch was
  // opened synchronously here, while the previous one was still tearing down.
  const raced = await Promise.race([
    state.transcriptFollows.get(key)!.watcher.then(() => "opened"),
    Promise.resolve("still closing"),
  ]);
  expect(raced).toBe("still closing");

  // And it does open, once the close is done. A latch that never lifts is the other failure.
  await state.transcriptFollows.get(key)!.watcher;
  expect(state.transcriptFollowClosing.has(key)).toBe(false);
  refollow();
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
