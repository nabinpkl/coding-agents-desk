// The file facts read off a contestant's events, across both harnesses' spellings of a tool.

import { describe, expect, test } from "bun:test";
import { filesFromEvents, outsideReaches } from "@/arena/arenaFacts";
import type { ActivityEvent } from "@/transcripts/transcriptTypes";

function toolEvent(id: string, tool: string, files: string[]): ActivityEvent {
  return {
    id,
    index: 0,
    revision: 1,
    phase: "complete",
    ts: 1,
    type: "assistant",
    blocks: [{ kind: "tool_use", tool, files }],
  };
}

describe("filesFromEvents", () => {
  test("reads Claude's capitalised tool names the way it reads the serve's", () => {
    const events: ActivityEvent[] = [
      {
        ...toolEvent("a", "Read", []),
        blocks: [{ kind: "tool_use", tool: "Read", input: { file_path: "/repo/a.ts" } }],
      },
      {
        ...toolEvent("b", "Edit", []),
        blocks: [{ kind: "tool_use", tool: "Edit", input: { file_path: "/repo/b.ts" } }],
      },
      {
        ...toolEvent("c", "MultiEdit", []),
        blocks: [{ kind: "tool_use", tool: "MultiEdit", input: { file_path: "/repo/c.ts" } }],
      },
    ];
    const { filesRead, filesWritten } = filesFromEvents(events);
    expect(filesRead).toEqual(["/repo/a.ts"]);
    expect(filesWritten).toEqual(["/repo/b.ts", "/repo/c.ts"]);
  });

  test("a search tool's path is the directory it searched, not a file it read", () => {
    const event: ActivityEvent = {
      ...toolEvent("a", "Grep", []),
      blocks: [{ kind: "tool_use", tool: "Grep", input: { pattern: "widget", path: "/repo/src" } }],
    };
    expect(filesFromEvents([event])).toEqual({ filesRead: [], filesWritten: [] });
  });

  test("splits the files by the direction the tool worked in", () => {
    const events = [
      toolEvent("a", "read", ["/repo/README", "/repo/notes"]),
      toolEvent("b", "write", ["/repo/README", "/repo/new.ts"]),
      toolEvent("c", "edit", ["/repo/new.ts"]),
      toolEvent("d", "bash", []), // no files named: a command, not a file
    ];
    const { filesRead, filesWritten } = filesFromEvents(events);
    expect(filesRead).toEqual(["/repo/README", "/repo/notes"]);
    expect(filesWritten).toEqual(["/repo/README", "/repo/new.ts"]);
  });

  test("names a file from the tool's own input when the block carries no files", () => {
    // Measured on this machine's serve: a `read` call names its file in its input alone, and
    // the opencode mapper resolves `files` only from a call's attachments.
    const event: ActivityEvent = {
      ...toolEvent("a", "read", []),
      blocks: [{ kind: "tool_use", tool: "read", input: { path: "/repo/README.md" } }],
    };
    const { filesRead, filesWritten } = filesFromEvents([event]);
    expect(filesRead).toEqual(["/repo/README.md"]);
    expect(filesWritten).toEqual([]);
  });

  test("prefers the adapter's own resolution when both name the file", () => {
    const event: ActivityEvent = {
      ...toolEvent("a", "read", ["/resolved/README"]),
      blocks: [
        {
          kind: "tool_use",
          tool: "read",
          files: ["/resolved/README"],
          input: { path: "/raw/README" },
        },
      ],
    };
    expect(filesFromEvents([event]).filesRead).toEqual(["/resolved/README"]);
  });

  test("a write tool's input names its file too, by the same fallback", () => {
    const event: ActivityEvent = {
      ...toolEvent("a", "write", []),
      blocks: [{ kind: "tool_use", tool: "write", input: { file_path: "/repo/fresh.ts" } }],
    };
    expect(filesFromEvents([event]).filesWritten).toEqual(["/repo/fresh.ts"]);
  });
});

describe("outsideReaches", () => {
  const where = {
    worktreePath: "/arena/run/c2",
    rivals: [{ contestantId: "c1", worktreePath: "/arena/run/c1", sessionId: "ses-c1" }],
    home: "/Users/me",
  };
  const call = (id: string, tool: string, input: Record<string, unknown>): ActivityEvent => ({
    ...toolEvent(id, tool, []),
    blocks: [{ kind: "tool_use", tool, input }],
  });

  test("its own worktree is not a reach, however the path is spelled", () => {
    const events = [
      call("a", "Read", { file_path: "/arena/run/c2/src/a.ts" }),
      call("b", "read", { path: "src/b.ts" }),
      call("c", "Bash", { command: "cat ./src/c.ts && ls ." }),
    ];
    expect(outsideReaches(events, where)).toEqual([]);
  });

  // The fairness case the fact exists for: plain agents are not refused a rival's worktree.
  test("a rival's worktree is named as that rival's, by a file tool, a search or a shell command", () => {
    const events = [
      call("a", "Read", { file_path: "/arena/run/c1/src/widget.ts" }),
      call("b", "Grep", { pattern: "widget", path: "../c1" }),
      call("c", "Bash", { command: "cd /tmp && cat '../c1/src/widget.ts' 2>/dev/null | head" }),
      call("d", "Edit", { file_path: "/arena/run/c1/notes.md" }),
    ];
    expect(outsideReaches(events, where)).toEqual([
      { path: "/arena/run/c1/src/widget.ts", how: "read", rival: "c1" },
      { path: "/arena/run/c1", how: "search", rival: "c1" },
      { path: "/arena/run/c1/src/widget.ts", how: "shell", rival: "c1" },
      { path: "/arena/run/c1/notes.md", how: "write", rival: "c1" },
    ]);
  });

  // The serve names its shell call `shell`, not `bash`: measured on a live duel, where both of an
  // opencode contestant's commands into its rival's folder went uncounted under the one name.
  test("reads the serve's `shell` call the way it reads Claude's `Bash`", () => {
    const events = [call("a", "shell", { command: "cat ../c1/NOTES.md ../c2/NOTES.md 2>/dev/null; true" })];
    expect(outsideReaches(events, where)).toEqual([{ path: "/arena/run/c1/NOTES.md", how: "shell", rival: "c1" }]);
  });

  test("a rival Claude contestant's transcript counts as the rival's, wherever it is filed", () => {
    const events = [call("a", "Bash", { command: "tail -n 20 ~/.claude/projects/-arena-run-c1/ses-c1.jsonl" })];
    expect(outsideReaches(events, where)).toEqual([
      { path: "/Users/me/.claude/projects/-arena-run-c1/ses-c1.jsonl", how: "shell", rival: "c1" },
    ]);
  });

  test("the home is a reach; the machine's own directories and a harness's spilled output are not", () => {
    const events = [
      call("a", "Bash", { command: "cat ~/.claude/plugins/posture.md > /tmp/p.txt && /usr/bin/env node -v" }),
      call("b", "read", { path: "/Users/me/.local/share/opencode/tool-output/tool_1" }),
      call("c", "Read", { file_path: "/Users/me/.claude/projects/-arena-run-c2/ses-c2/tool-results/x.txt" }),
      call("d", "Bash", { command: "curl https://example.com/a/../b" }),
    ];
    expect(outsideReaches(events, where)).toEqual([
      { path: "/Users/me/.claude/plugins/posture.md", how: "shell", rival: null },
    ]);
  });

  test("an assignment or an option is read for its value, and a repeat is counted once", () => {
    const events = [
      call("a", "Bash", { command: "OUT=/Users/me/notes bun run x --dir=../c1" }),
      call("b", "Bash", { command: "ls /Users/me/notes" }),
    ];
    expect(outsideReaches(events, where)).toEqual([
      { path: "/Users/me/notes", how: "shell", rival: null },
      { path: "/arena/run/c1", how: "shell", rival: "c1" },
    ]);
  });
});
