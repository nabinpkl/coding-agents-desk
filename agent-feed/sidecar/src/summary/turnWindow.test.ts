import { expect, test } from "bun:test";
import type { ActivityEvent } from "../transcripts/sources/transcriptTypes.ts";
import { resolveTurnWindow, type PageReader } from "./turnWindow.ts";

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
  runCommand: (async () => "") as (argv: readonly string[]) => Promise<string>,
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

test("git state becomes both a prompt block and parsed file changes", async () => {
  const runCommand = async (argv: readonly string[]): Promise<string> => {
    if (argv.includes("--numstat")) return "12\t3\tsrc/a.ts\n-\t-\tassets/logo.png\n";
    if (argv.includes("--name-status")) return "M\tsrc/a.ts\nA\tassets/logo.png\n";
    if (argv.includes("--others")) return "notes/new.md\n";
    return "";
  };
  const window = (await resolveTurnWindow({
    ...options,
    runCommand,
    readPage: reader([event(0, "user"), event(1, "assistant")]),
  }))!;
  expect(window.filesTouched).toEqual([
    { path: "src/a.ts", status: "M", added: 12, removed: 3 },
    // A binary file reports `-` for both counts; it must not become NaN.
    { path: "assets/logo.png", status: "A", added: 0, removed: 0 },
    // Untracked files are invisible to every form of `git diff` and are the most common
    // thing a turn produces.
    { path: "notes/new.md", status: "?", added: 0, removed: 0 },
  ]);
  expect(window.gitBlock).toContain("src/a.ts");
  expect(window.gitBlock).toContain("notes/new.md");
});

test("a project with no changes carries an empty block, not the word undefined", async () => {
  const window = (await resolveTurnWindow({
    ...options,
    readPage: reader([event(0, "user")]),
  }))!;
  expect(window.gitBlock).toBe("");
  expect(window.filesTouched).toEqual([]);
});
