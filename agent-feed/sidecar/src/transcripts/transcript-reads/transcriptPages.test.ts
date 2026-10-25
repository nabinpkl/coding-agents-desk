import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readEventRaw,
  readEventsBetween,
  readPageAfter,
  readPageAround,
  readPageBefore,
  readSessionMeter,
} from "@/transcripts/transcript-reads/transcriptPages";
import { completeEnd, LINE_READ_BYTES, linesBefore } from "@/transcripts/transcript-reads/transcriptLines";
import {
  clearFollowsForTest,
  followSettledForTest,
  followTranscript,
  syncFollowedTranscript,
} from "@/transcripts/transcript-reads/transcriptFollow";
import type { ParsedTranscriptLine } from "@/transcripts/transcript-reads/transcriptPages";

const roots: string[] = [];
const source = "codex" as const;
const sessionId = "11111111-1111-1111-1111-111111111111";

afterEach(async () => {
  clearFollowsForTest();
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/** One content line, the shape the codex adapter turns into a visible event. */
function contentLine(turn: number, text = `turn ${turn}`): string {
  return JSON.stringify({
    timestamp: `2026-01-01T00:00:${String(turn % 60).padStart(2, "0")}Z`,
    type: "response_item",
    payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] },
  });
}

/** One machinery line: shown in the raw view, absent from the nice one. */
function machineryLine(turn: number): string {
  return JSON.stringify({
    timestamp: `2026-01-01T00:00:${String(turn % 60).padStart(2, "0")}Z`,
    type: "event_msg",
    payload: { type: "token_count", info: null },
  });
}

async function transcript(lines: readonly string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "transcript-pages-"));
  roots.push(root);
  const path = join(root, "rollout.jsonl");
  await writeFile(path, `${lines.join("\n")}\n`);
  return path;
}

/** Where each line starts once written one per line: what a row is named by. */
function positions(lines: readonly string[]): number[] {
  const starts: number[] = [];
  let at = 0;
  for (const line of lines) {
    starts.push(at);
    at += Buffer.byteLength(line) + 1;
  }
  return starts;
}

/** Content and machinery interleaved, which is what makes the two views disagree. */
function interleaved(turns: number): string[] {
  const lines: string[] = [];
  for (let turn = 0; turn < turns; turn += 1) {
    lines.push(contentLine(turn));
    if (turn % 3 === 0) lines.push(machineryLine(turn));
  }
  return lines;
}

const texts = (events: { blocks: { text?: string }[] }[]) => events.map((event) => event.blocks[0]?.text);

describe("reading a page back from a position", () => {
  test("the newest page is the end of the file, named by where each line starts", async () => {
    const lines = interleaved(12);
    const path = await transcript(lines);
    const at = positions(lines);

    const page = await readPageBefore(source, sessionId, path, null, 4, "nice");

    expect(texts(page.events)).toEqual(["turn 8", "turn 9", "turn 10", "turn 11"]);
    expect(page.events.map((event) => event.index)).toEqual(
      ["turn 8", "turn 9", "turn 10", "turn 11"].map(
        (text) => at[lines.findIndex((line) => line.includes(`"${text}"`))]!,
      ),
    );
    expect(page.end).toBe(Buffer.byteLength(`${lines.join("\n")}\n`));
    // Older rows exist, so the page starts at its own oldest row.
    expect(page.windowStart).toBe(page.events[0]!.index);
  });

  test("every row names the one before it in its own view, the oldest one included", async () => {
    const lines = interleaved(12);
    const path = await transcript(lines);

    for (const mode of ["nice", "raw"] as const) {
      const page = await readPageBefore(source, sessionId, path, null, 5, mode);
      const older = await readPageBefore(source, sessionId, path, page.windowStart, 5, mode);
      // The page before ends exactly at the row the newer page's oldest row says precedes it.
      expect(page.events[0]!.previous).toBe(older.events.at(-1)!.index);
      for (let row = 1; row < page.events.length; row += 1) {
        expect(page.events[row]!.previous).toBe(page.events[row - 1]!.index);
      }
    }
  });

  test("paging back reaches the first row and then says there is nothing older", async () => {
    const lines = interleaved(12);
    const path = await transcript(lines);
    const seen: string[] = [];
    let before: number | null = null;
    for (let step = 0; step < 10; step += 1) {
      const page = await readPageBefore(source, sessionId, path, before, 5, "nice");
      seen.unshift(...texts(page.events).map(String));
      if (page.windowStart === 0) {
        expect(page.events[0]!.previous).toBeNull();
        break;
      }
      before = page.windowStart;
    }
    expect(seen).toEqual(Array.from({ length: 12 }, (_, turn) => `turn ${turn}`));
  });

  test("a line is the same position in both views, and only content has a counterpart", async () => {
    const lines = interleaved(6);
    const path = await transcript(lines);
    const raw = await readPageBefore(source, sessionId, path, null, 100, "raw");
    const nice = await readPageBefore(source, sessionId, path, null, 100, "nice");

    expect(raw.events).toHaveLength(lines.length);
    expect(nice.events).toHaveLength(6);
    for (const event of nice.events) {
      expect(raw.events.find((row) => row.index === event.index)?.otherModeIndex).toBe(event.index);
    }
    const machinery = raw.events.filter((event) => !nice.events.some((row) => row.index === event.index));
    expect(machinery.every((event) => event.otherModeIndex === null)).toBe(true);
  });

  test("a line still being written is not read until its newline lands", async () => {
    const lines = [contentLine(0), contentLine(1)];
    const path = await transcript(lines);
    await appendFile(path, contentLine(2).slice(0, 20));

    const page = await readPageBefore(source, sessionId, path, null, 10, "nice");
    expect(texts(page.events)).toEqual(["turn 0", "turn 1"]);
    expect(page.end).toBe(Buffer.byteLength(`${lines.join("\n")}\n`));
  });

  test("lines longer than one read, and lines that cross a read's edge, arrive whole", async () => {
    const long = "x".repeat(LINE_READ_BYTES + 512);
    const lines = [contentLine(0), contentLine(1, long), contentLine(2), contentLine(3, long)];
    const path = await transcript(lines);

    const page = await readPageBefore(source, sessionId, path, null, 10, "nice");
    expect(texts(page.events)).toEqual(["turn 0", long, "turn 2", long]);
    expect(page.events.map((event) => event.index)).toEqual(positions(lines));
    expect(page.windowStart).toBe(0);
  });

  test("refuses a position that is not where a line starts", async () => {
    const lines = interleaved(3);
    const path = await transcript(lines);
    await expect(readPageBefore(source, sessionId, path, 7, 5, "nice")).rejects.toThrow(/not where a line starts/);
  });

  test("an empty transcript is an empty page with nothing older", async () => {
    const root = await mkdtemp(join(tmpdir(), "transcript-pages-"));
    roots.push(root);
    const path = join(root, "rollout.jsonl");
    await writeFile(path, "");
    const page = await readPageBefore(source, sessionId, path, null, 5, "nice");
    expect(page).toEqual({ events: [], windowStart: 0, end: 0 });
  });
});

describe("reading a page after or around a position", () => {
  test("after a row: the rows that follow it, joined to it, in either view", async () => {
    const lines = interleaved(9);
    const path = await transcript(lines);
    const at = positions(lines);
    const turnAt = (turn: number) => at[lines.findIndex((line) => line.includes(`"turn ${turn}"`))]!;

    const nice = await readPageAfter(source, sessionId, path, turnAt(3), 3, "nice");
    expect(texts(nice.events)).toEqual(["turn 4", "turn 5", "turn 6"]);
    expect(nice.events[0]!.previous).toBe(turnAt(3));
    expect(nice.windowStart).toBe(turnAt(4));

    // Turn 3 is followed by its machinery line, which only the raw view shows.
    const raw = await readPageAfter(source, sessionId, path, turnAt(3), 2, "raw");
    expect(raw.events.map((event) => event.index)).toEqual([
      turnAt(3) + Buffer.byteLength(lines[at.indexOf(turnAt(3))]!) + 1,
      turnAt(4),
    ]);
  });

  test("after the newest row: nothing, and a position inside a line is refused", async () => {
    const lines = interleaved(3);
    const path = await transcript(lines);
    const at = positions(lines);
    expect((await readPageAfter(source, sessionId, path, at.at(-1)!, 5, "raw")).events).toEqual([]);
    await expect(readPageAfter(source, sessionId, path, at[1]! + 1, 5, "raw")).rejects.toThrow(
      "not where a line starts",
    );
  });

  test("around a row: the row and rows either side, joined in one run", async () => {
    const lines = interleaved(12);
    const path = await transcript(lines);
    const at = positions(lines);
    const turnAt = (turn: number) => at[lines.findIndex((line) => line.includes(`"turn ${turn}"`))]!;

    const page = await readPageAround(source, sessionId, path, turnAt(6), 4, "nice");
    expect(texts(page.events)).toEqual(["turn 4", "turn 5", "turn 6", "turn 7"]);
    for (let row = 1; row < page.events.length; row += 1) {
      expect(page.events[row]!.previous).toBe(page.events[row - 1]!.index);
    }
    expect(page.windowStart).toBe(turnAt(4));
  });

  test("around a machinery line in the nice view: the rows either side of where it sits", async () => {
    const lines = interleaved(9);
    const path = await transcript(lines);
    const at = positions(lines);
    // Turn 3's machinery line, which sits between turn 3 and turn 4.
    const machinery = lines.findIndex((line, index) => index > 1 && line.includes("token_count"));

    const page = await readPageAround(source, sessionId, path, at[machinery]!, 4, "nice");
    expect(texts(page.events)).toEqual(["turn 2", "turn 3", "turn 4", "turn 5"]);
    expect(page.events[2]!.previous).toBe(page.events[1]!.index);
  });

  test("around the first row: nothing is older, so the page starts the file", async () => {
    const lines = interleaved(6);
    const path = await transcript(lines);
    const page = await readPageAround(source, sessionId, path, 0, 4, "nice");
    expect(texts(page.events)).toEqual(["turn 0", "turn 1"]);
    expect(page.windowStart).toBe(0);
    expect(page.events[0]!.previous).toBeNull();
  });
});

describe("one line by its position", () => {
  test("answers the exact bytes of the line, and null for a position inside one", async () => {
    const lines = interleaved(3);
    const path = await transcript(lines);
    const at = positions(lines);

    expect(await readEventRaw(path, at[2]!)).toBe(lines[2]!);
    expect(await readEventRaw(path, at[2]! + 1)).toBeNull();
    expect(await readEventRaw(path, 10_000_000)).toBeNull();
  });
});

describe("a span read forward", () => {
  test("carries the row before it, so it joins the rows already held", async () => {
    const lines = interleaved(6);
    const path = await transcript(lines);
    const at = positions(lines);
    const end = await completeEnd(path);

    const events = await readEventsBetween(source, sessionId, path, at[3]!, end, "nice", at[2]!);
    expect(events[0]!.previous).toBe(at[2]);
    expect(events.at(-1)!.index).toBe(at.at(-1)!);
  });
});

describe("reading lines backwards", () => {
  test("stops where the visitor says, without reading the rest of the file", async () => {
    const lines = interleaved(40);
    const path = await transcript(lines);
    const visited: number[] = [];
    await linesBefore(path, await completeEnd(path), (line) => {
      visited.push(line.position);
      return visited.length < 3;
    });
    expect(visited).toEqual(positions(lines).slice(-3).reverse());
  });
});

describe("the occupancy meter", () => {
  test("is the newest report, read from the end", async () => {
    const usageLine = (tokens: number) =>
      JSON.stringify({
        timestamp: "2026-01-01T00:00:00Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: { input_tokens: tokens, output_tokens: 0, total_tokens: tokens },
            last_token_usage: { input_tokens: tokens, output_tokens: 0, total_tokens: tokens },
            model_context_window: 200_000,
          },
        },
      });
    const lines = [contentLine(0), usageLine(1000), contentLine(1), usageLine(4200), contentLine(2)];
    const path = await transcript(lines);

    const meter = await readSessionMeter(source, path, await completeEnd(path));
    expect(meter.usage?.current).toBe(4200);
    expect(meter.usage?.limit).toBe(200_000);
  });
});

describe("following a transcript", () => {
  test("a reader hears appended lines in order, each once, from where its page ended", async () => {
    const lines = [contentLine(0)];
    const path = await transcript(lines);
    const end = await completeEnd(path);
    const heard: ParsedTranscriptLine[] = [];
    const follow = followTranscript(
      source,
      sessionId,
      path,
      (line) => heard.push(line),
      () => {},
    );
    expect(follow.start(end, { usage: null, model: undefined })).toBe(end);

    await appendFile(path, `${[contentLine(1), contentLine(2)].join("\n")}\n`);
    syncFollowedTranscript(source, sessionId);
    await followSettledForTest(source, sessionId);

    expect(heard.map((line) => line.position)).toEqual([end, end + Buffer.byteLength(`${contentLine(1)}\n`)]);
    follow.release();
  });

  test("a second reader is told where the follow already is, so it can read what came between", async () => {
    const path = await transcript([contentLine(0)]);
    const first = await completeEnd(path);
    const one = followTranscript(
      source,
      sessionId,
      path,
      () => {},
      () => {},
    );
    one.start(first, { usage: null, model: undefined });
    await appendFile(path, `${contentLine(1)}\n`);
    syncFollowedTranscript(source, sessionId);
    const grown = await completeEnd(path);
    // The first reader's follow reads past the second reader's page end before the second starts.
    await followSettledForTest(source, sessionId);
    const two = followTranscript(
      source,
      sessionId,
      path,
      () => {},
      () => {},
    );
    const from = two.start(first, { usage: null, model: undefined });
    // Not the second reader's own page end: the follow had already read past it.
    expect(from).toBe(grown);
    one.release();
    two.release();
  });

  test("a transcript that shrinks is reported rather than read against stale positions", async () => {
    const path = await transcript([contentLine(0), contentLine(1)]);
    const errors: unknown[] = [];
    const follow = followTranscript(
      source,
      sessionId,
      path,
      () => {},
      (error) => errors.push(error),
    );
    follow.start(await completeEnd(path), { usage: null, model: undefined });
    await writeFile(path, `${contentLine(0)}\n`);
    syncFollowedTranscript(source, sessionId);
    await followSettledForTest(source, sessionId);
    expect(String(errors[0])).toMatch(/shrank/);
    follow.release();
  });
});
