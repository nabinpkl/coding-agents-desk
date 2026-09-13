import { expect, test } from "bun:test";
import type { ActivityBlock, ActivityEvent } from "@/transcripts/transcriptTypes";
import { describeToolCall, filesTouchedIn } from "@/summary/toolCalls";

const PROJECT = "/Users/dev/projects/agent-desk";

function event(blocks: ActivityBlock[], index = 0): ActivityEvent {
  return {
    id: `e${index}`,
    index,
    revision: 0,
    phase: "complete",
    ts: index,
    type: "assistant",
    blocks,
  };
}

function call(tool: string, input: Record<string, unknown>): ActivityBlock {
  return { kind: "tool_use", tool, input };
}

test("a turn's writes and edits are read from its own tool calls", () => {
  const files = filesTouchedIn([
    event([call("Write", { file_path: "src/new.ts", content: "a\nb\nc" })], 0),
    event([call("Edit", { file_path: "src/old.ts", old_string: "x\ny", new_string: "x\ny\nz" })], 1),
  ], PROJECT);

  expect(files).toEqual([
    { path: "src/new.ts", action: "wrote", edits: 1, added: 3, removed: 0 },
    { path: "src/old.ts", action: "edited", edits: 1, added: 3, removed: 2 },
  ]);
});

test("a file touched repeatedly is one entry that says how often", () => {
  const files = filesTouchedIn([
    event([call("Write", { file_path: "a.ts", content: "one" })], 0),
    event([call("Edit", { file_path: "a.ts", old_string: "one", new_string: "two" })], 1),
    event([call("Edit", { file_path: "a.ts", old_string: "two", new_string: "three" })], 2),
  ], PROJECT);

  // The first action is the one kept: it is what says the file was created in this turn rather
  // than found here. Going back and forth over it three times is the other half of the story.
  expect(files).toEqual([{ path: "a.ts", action: "wrote", edits: 3, added: 3, removed: 2 }]);
});

test("reads, searches and shell calls change no files", () => {
  const files = filesTouchedIn([
    event([
      call("Read", { file_path: "src/a.ts" }),
      call("Grep", { pattern: "TODO", path: "src" }),
      call("Bash", { command: "just check" }),
    ]),
  ], PROJECT);
  expect(files).toEqual([]);
});

test("Codex's apply_patch counts as an edit", () => {
  // A different harness, the same question. Codex records the path on the call rather than the
  // payload, so the line counts are zero and the path is not.
  const files = filesTouchedIn([event([call("apply_patch", { file_path: "guides/README.md" })])], PROJECT);
  expect(files).toEqual([
    { path: "guides/README.md", action: "edited", edits: 1, added: 0, removed: 0 },
  ]);
});

test("a write tool with no path is not a file change", () => {
  // Rather than inventing one. A call this module cannot attribute to a file still renders in
  // the transcript by name; it just does not appear in a list of files.
  expect(filesTouchedIn([event([call("Edit", { old_string: "a", new_string: "b" })])], PROJECT)).toEqual([]);
});

test("a call is described by its verb and its object, not its payload", () => {
  expect(describeToolCall(call("Read", { file_path: "src/a.ts", offset: 1, limit: 200 })))
    .toBe("Read src/a.ts");
  expect(describeToolCall(call("Bash", { command: "just check", description: "run the gate" })))
    .toBe("Bash command=just check description=run the gate");
  expect(describeToolCall(call("Grep", { pattern: "getAllTools", path: "src" })))
    .toBe("Grep src pattern=getAllTools");
});

test("a write is described by its size, never by its contents", () => {
  // The point of the cap: a `content` payload is a whole file, and a summarizer does not need
  // the file to know the file was written.
  const described = describeToolCall(call("Write", { file_path: "a.ts", content: "x\n".repeat(500) }));
  expect(described).toBe("Write a.ts +501/-0 lines");
  expect(described.length).toBeLessThan(60);
});

test("a path inside the project is named relative to it, one outside is not", () => {
  // The harnesses record absolute paths. Left alone the file list is a column of the same
  // prefix with the part that differs pushed off the right edge.
  const files = filesTouchedIn([
    event([call("Write", { file_path: `${PROJECT}/src/a.ts`, content: "x" })], 0),
    event([call("Write", { file_path: "/tmp/scratch.log", content: "y" })], 1),
  ], PROJECT);
  expect(files.map((file) => file.path)).toEqual(["src/a.ts", "/tmp/scratch.log"]);
});

test("a label that already leads with the tool's name is not given it twice", () => {
  // What the adapters write for an MCP call. Prefixing the name again produced
  // `mcp__x__javascript_tool mcp__x__javascript_tool javascript_exec` on every one of them.
  const block: ActivityBlock = {
    kind: "tool_use",
    tool: "mcp__chrome__javascript_tool",
    summary: "mcp__chrome__javascript_tool javascript_exec",
  };
  expect(describeToolCall(block)).toBe("mcp__chrome__javascript_tool javascript_exec");
});

test("a tool this module has never heard of still renders by name", () => {
  expect(describeToolCall(call("WebFetch", { url: "https://example.com" })))
    .toBe("WebFetch url=https://example.com");
  expect(describeToolCall(call("SomethingNew", {}))).toBe("SomethingNew");
});
