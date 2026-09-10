import { expect, test } from "bun:test";
import type { ActivityEvent } from "@/transcripts/transcriptTypes";
import { resolveTurnWindow, type PageReader } from "@/summary/turnWindow";

function event(index: number, type: ActivityEvent["type"], text = "x"): ActivityEvent {
  return {
    id: `e${index}`,
    index,
    revision: 0,
    phase: "complete",
    ts: 1_750_000_000_000 + index,
    type,
    blocks: [{ kind: "text", text }],
  };
}

/** Serves a fixed list, honouring offset/limit the way the real readers do. */
function reader(events: ActivityEvent[]): PageReader {
  return async (offset, limit) => ({ events: events.slice(offset, offset + limit), total: events.length });
}

const options = {
  project: "/tmp/project",
  mode: "nice" as const,
  tokenCeiling: 100_000,
};

test("window starts at the most recent user message", async () => {
  const events = [
    event(0, "user"), event(1, "assistant"), event(2, "assistant"),
    event(3, "user"), event(4, "assistant"), event(5, "assistant"),
  ];
  const window = (await resolveTurnWindow({ ...options, readPage: reader(events) }))!;
  expect(window.events.map((e) => e.index)).toEqual([3, 4, 5]);
  expect(window.coverage).toMatchObject({ fromEventIndex: 3, toEventIndex: 5, truncated: false });
});

test("a tool result does not start a turn, however the harness typed it", async () => {
  // The bug this rule exists for. Both harnesses record tool results as user lines, so looking
  // back for `type === "user"` found the tail of a tool loop: the window became the two events
  // after it, and the digest described a tool result as the person speaking.
  const toolResult: ActivityEvent = {
    ...event(4, "user"),
    blocks: [{ kind: "tool_result", text: "File created successfully at: /tmp/a.ts" }],
  };
  const events = [
    event(0, "assistant"),
    { ...event(1, "user"), blocks: [{ kind: "text" as const, text: "fix the parser" }] },
    event(2, "assistant"),
    event(3, "assistant"),
    toolResult,
    event(5, "assistant"),
  ];

  const window = (await resolveTurnWindow({ ...options, readPage: reader(events) }))!;

  expect(window.events.map((e) => e.index)).toEqual([1, 2, 3, 4, 5]);
  expect(window.coverage.truncated).toBe(false);
});

test("a slash command's own output does not start a turn", async () => {
  // `/compact` writes its stdout as a user message, and it reads as ordinary prose. Left
  // unfiltered it became the most recent "user message" and the turn was the compaction.
  const events = [
    { ...event(0, "user"), blocks: [{ kind: "text" as const, text: "commit both suitably" }] },
    event(1, "assistant"),
    { ...event(2, "user"), blocks: [{ kind: "text" as const, text: "<command-name>/compact</command-name>" }] },
    { ...event(3, "user"), blocks: [{ kind: "text" as const, text: "<local-command-stdout>Compacted </local-command-stdout>" }] },
    event(4, "assistant"),
  ];

  const window = (await resolveTurnWindow({ ...options, readPage: reader(events) }))!;

  expect(window.coverage.fromEventIndex).toBe(0);
});

test("pages back for a boundary outside the first scan page", async () => {
  // 250 events with the only user message at 5: the boundary is three pages back.
  const events = Array.from({ length: 250 }, (_, i) => event(i, i === 5 ? "user" : "assistant"));
  const window = (await resolveTurnWindow({ ...options, readPage: reader(events) }))!;
  expect(window.coverage.fromEventIndex).toBe(5);
  expect(window.coverage.toEventIndex).toBe(249);
  expect(window.coverage.truncated).toBe(false);
});

test("a turn with no user message anywhere reports truncated rather than lying", async () => {
  const events = Array.from({ length: 40 }, (_, i) => event(i, "assistant"));
  const window = (await resolveTurnWindow({ ...options, readPage: reader(events) }))!;
  expect(window.coverage.truncated).toBe(true);
});

test("an oversized turn keeps both ends and marks itself truncated", async () => {
  const body = "y".repeat(4_000);
  const events = [
    event(0, "user", "the request"),
    ...Array.from({ length: 60 }, (_, i) => event(i + 1, "assistant", body)),
    event(61, "assistant", "the last word"),
  ];
  // 61 * 4000 chars against a ceiling of 2000 tokens (~7000 chars): most of the middle must go.
  const window = (await resolveTurnWindow({ ...options, tokenCeiling: 2_000, readPage: reader(events) }))!;
  expect(window.coverage.truncated).toBe(true);
  expect(window.events.length).toBeLessThan(events.length);
  expect(window.events[0]!.index).toBe(0);
  expect(window.events[window.events.length - 1]!.index).toBe(61);
});

test("an empty session yields no window", async () => {
  expect(await resolveTurnWindow({ ...options, readPage: reader([]) })).toBeNull();
});

test("the files the window reports are the ones its own events changed", async () => {
  const wrote: ActivityEvent = {
    ...event(4, "assistant"),
    blocks: [{ kind: "tool_use", tool: "Write", input: { file_path: "src/a.ts", content: "one\ntwo" } }],
  };
  const window = (await resolveTurnWindow({
    ...options,
    readPage: reader([event(0, "user"), event(1, "assistant"), event(3, "user"), wrote]),
  }))!;
  // From the turn, not from the checkout: the earlier events belong to a previous turn and
  // whatever they wrote is not this turn's doing.
  expect(window.filesTouched).toEqual([
    { path: "src/a.ts", action: "wrote", edits: 1, added: 2, removed: 0 },
  ]);
});

test("a turn that changed nothing reports no files", async () => {
  const window = (await resolveTurnWindow({
    ...options,
    readPage: reader([event(0, "user"), event(1, "assistant")]),
  }))!;
  expect(window.filesTouched).toEqual([]);
});

test("a file whose edit fell in the dropped middle is not claimed", async () => {
  // The window is what the summarizer will be shown; listing a file it cannot see would invite a
  // digest that describes a change with no evidence for it anywhere in the prompt.
  const body = "y".repeat(4_000);
  const buried: ActivityEvent = {
    ...event(30, "assistant"),
    blocks: [{ kind: "tool_use", tool: "Write", input: { file_path: "buried.ts", content: body } }],
  };
  const events = [
    event(0, "user", "the request"),
    ...Array.from({ length: 29 }, (_, i) => event(i + 1, "assistant", body)),
    buried,
    ...Array.from({ length: 29 }, (_, i) => event(i + 31, "assistant", body)),
    event(60, "assistant", "the last word"),
  ];
  const window = (await resolveTurnWindow({ ...options, tokenCeiling: 2_000, readPage: reader(events) }))!;
  expect(window.coverage.truncated).toBe(true);
  expect(window.filesTouched).toEqual([]);
});
