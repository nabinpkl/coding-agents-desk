// The file facts read off a contestant's events, across both harnesses' spellings of a tool.

import { describe, expect, test } from "bun:test";
import { filesFromEvents } from "@/arena/arenaFacts";
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
      { ...toolEvent("a", "Read", []), blocks: [{ kind: "tool_use", tool: "Read", input: { file_path: "/repo/a.ts" } }] },
      { ...toolEvent("b", "Edit", []), blocks: [{ kind: "tool_use", tool: "Edit", input: { file_path: "/repo/b.ts" } }] },
      { ...toolEvent("c", "MultiEdit", []), blocks: [{ kind: "tool_use", tool: "MultiEdit", input: { file_path: "/repo/c.ts" } }] },
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
      blocks: [{
        kind: "tool_use",
        tool: "read",
        files: ["/resolved/README"],
        input: { path: "/raw/README" },
      }],
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
