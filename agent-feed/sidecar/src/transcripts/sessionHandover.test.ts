// Fixtures mirror `messageAnchor.test.ts`: real JSONL shapes on real temp files, read through
// the same index the renderer uses, so the test proves the render against the parse.

import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildHandoverPrompt,
  capHeadTail,
  collapseRepeatedLines,
  renderHandover,
  SessionHandoverError,
  type RenderedHandover,
} from "@/transcripts/sessionHandover";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

let sessionCounter = 0;
function sessionId(): string {
  sessionCounter += 1;
  return `99999999-9999-4999-8999-9999999999${String(sessionCounter).padStart(2, "0")}`;
}

function line(record: Record<string, unknown>): string {
  return JSON.stringify({
    cwd: "/tmp/project",
    timestamp: "2026-09-09T05:00:00.000Z",
    uuid: crypto.randomUUID(),
    ...record,
  });
}

function said(text: string): string {
  return line({ type: "user", message: { role: "user", content: text } });
}

function replied(text: string): string {
  return line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
}

function ranTool(name: string, input: Record<string, unknown>, output: string): readonly string[] {
  return [
    line({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name, input }] },
    }),
    line({
      type: "user",
      message: {
        role: "user",
        content: [{ tool_use_id: "toolu_1", type: "tool_result", content: output }],
      },
    }),
  ];
}

function compacted(summary: string): readonly string[] {
  return [
    line({ type: "system", subtype: "compact_boundary", content: "Conversation compacted" }),
    line({ type: "user", isCompactSummary: true, message: { role: "user", content: summary } }),
  ];
}

async function transcript(id: string, lines: readonly string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "session-handover-"));
  roots.push(root);
  const path = join(root, `${id}.jsonl`);
  await writeFile(path, `${lines.join("\n")}\n`);
  return path;
}

test("pairs stay verbatim, runs of three collapse with their count", () => {
  expect(collapseRepeatedLines("a\na").text).toBe("a\na");
  const three = collapseRepeatedLines("warn\nwarn\nwarn");
  expect(three.text).toBe("warn (×3)");
  expect(three.collapsed).toBe(true);
  expect(collapseRepeatedLines("a\nb\na").collapsed).toBe(false);
});

test("short tool text passes through, long text keeps head and tail", () => {
  expect(capHeadTail("short").capped).toBe(false);
  const long = `HEAD-${"x".repeat(250)}\n${"middle\n".repeat(20)}TAIL-${"y".repeat(150)}`;
  const capped = capHeadTail(long);
  expect(capped.capped).toBe(true);
  expect(capped.text.startsWith("HEAD-")).toBe(true);
  expect(capped.text.endsWith("y".repeat(100))).toBe(true);
  expect(capped.text).not.toContain("TAIL-");
  expect(capped.text).toContain("middle cut");
});

test("the summary and the turns since the boundary are what the prompt carries", async () => {
  const id = sessionId();
  const path = await transcript(id, [
    said("before the reset"),
    replied("old answer"),
    ...compacted("Primary request: fix the tile scroll."),
    said("did it land?"),
    ...ranTool("Bash", { command: "git log --oneline -3" }, "abc first\nabc first\nabc first\nok"),
    replied("it landed"),
  ]);
  const handover = await renderHandover(id, path);
  expect(handover.summary).toBe("Primary request: fix the tile scroll.");
  expect(handover.turns).toContain("human: did it land?");
  expect(handover.turns).toContain("assistant: it landed");
  expect(handover.turns).toContain("[tool: Bash");
  // The repeated lines inside the one result collapse; the turn before the boundary is gone.
  expect(handover.turns).toContain("abc first (×3)");
  expect(handover.turns).not.toContain("before the reset");
  expect(handover.turns).not.toContain("old answer");
});

test("distinct runs of one tool stay distinct", async () => {
  const id = sessionId();
  const path = await transcript(id, [
    ...compacted("summary"),
    ...ranTool("Bash", { command: "first" }, "out one"),
    ...ranTool("Bash", { command: "second" }, "out two"),
  ]);
  const handover = await renderHandover(id, path);
  expect(handover.turns).toContain("out one");
  expect(handover.turns).toContain("out two");
  expect(handover.turnCount).toBe(4);
});

test("a session that was never compacted hands over every turn, with no summary", async () => {
  const id = sessionId();
  const path = await transcript(id, [
    said("hello"),
    ...ranTool("Bash", { command: "cat big.log" }, `HEAD-${"x".repeat(400)}-TAIL`),
    replied("hi"),
  ]);
  const handover = await renderHandover(id, path);
  expect(handover.summary).toBeNull();
  expect(handover.turns).toContain("human: hello");
  expect(handover.turns).toContain("assistant: hi");
  // The stripping a compaction used to stand in for: the tool output is cut to head and tail.
  expect(handover.turns).toContain("middle cut");
  expect(handover.lossy).toBe(true);
});

test("a session with nothing said in it has no handover", async () => {
  const id = sessionId();
  const path = await transcript(id, []);
  await expect(renderHandover(id, path)).rejects.toBeInstanceOf(SessionHandoverError);
});

test("an uncompacted handover says so instead of carrying an empty summary section", () => {
  const handover: RenderedHandover = { summary: null, turns: "human: hi", turnCount: 1, lossy: false };
  const prompt = buildHandoverPrompt({ source: "opencode", sessionId: "abc", handover });
  expect(prompt).toContain("=== CONVERSATION (1 turns; never compacted) ===\nhuman: hi");
  expect(prompt).not.toContain("COMPACTION");
});

test("the prompt names its provenance and carries the reader's message last", () => {
  const handover: RenderedHandover = { summary: "S", turns: "human: hi", turnCount: 1, lossy: false };
  const prompt = buildHandoverPrompt({ source: "claude", sessionId: "abc", handover, message: "go on" });
  expect(prompt.startsWith("This was obtained from an earlier session from another agent")).toBe(true);
  expect(prompt).toContain("(claude, session abc)");
  expect(prompt.indexOf("=== COMPACTION SUMMARY ===")).toBeLessThan(prompt.indexOf("=== MESSAGE FROM THE READER ==="));
  expect(prompt.endsWith("go on\n")).toBe(true);
});

test("a lossy handover says so up front", () => {
  const handover: RenderedHandover = { summary: "S", turns: "", turnCount: 0, lossy: true };
  expect(buildHandoverPrompt({ source: "claude", sessionId: "abc", handover })).toContain("collapsed and capped");
});
