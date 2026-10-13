// The facts a contestant's own events say: which files its tools read and which they wrote.
//
// Read off the events exactly once, here, whichever harness produced them, which is why a run's
// file facts mean the same thing for an opencode contestant and a Claude one.

import type { ActivityBlock, ActivityEvent } from "@/transcripts/transcriptTypes";

/**
 * Tool names, lowercased, by the direction they work in. Lowercased because the two harnesses
 * spell one tool two ways (`read` on the serve, `Read` in Claude). Only these two sets may
 * name a file from their input: a search tool's `path` is the directory it searched, not a
 * file it read, so anything else counts only the files its adapter resolved.
 */
const WRITE_TOOLS = new Set(["write", "edit", "multiedit", "notebookedit", "patch"]);
const READ_TOOLS = new Set(["read", "notebookread"]);

/**
 * The input keys a file tool names its file by, across the sources this arena drives.
 *
 * The opencode serve's `read` says `path`; Claude's `Read` says `file_path`; a notebook tool
 * says `notebook_path`. The list is what each source's own transcript shape demands, and a
 * source whose tools name a file a fifth way lands here in the same change.
 */
const FILE_INPUT_KEYS = ["path", "file_path", "filePath", "notebook_path"] as const;

function fileFromToolInput(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const record = input as Record<string, unknown>;
  for (const key of FILE_INPUT_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

/**
 * The files a contestant's tools named, from the events its turn produced.
 *
 * `files` on a tool_use block is the adapter's own resolution of what the call named, so that
 * is read first and never re-derived. But the opencode mapper resolves `files` only from the
 * attachments a tool carried -- measured on this machine's serve, a `read` call names its
 * file in its input alone -- so a read or write tool's own input is the fallback, by the keys
 * above. A tool that names no file either way is left alone: a shell command or a search is a
 * fact the transcript holds, not a file the arena counts.
 */
export function filesFromEvents(events: readonly ActivityEvent[]): {
  filesRead: string[];
  filesWritten: string[];
} {
  const read = new Set<string>();
  const written = new Set<string>();
  for (const event of events) {
    for (const block of event.blocks as ActivityBlock[]) {
      if (block.kind !== "tool_use" || !block.tool) continue;
      const tool = block.tool.toLowerCase();
      const writes = WRITE_TOOLS.has(tool);
      const fromInput = writes || READ_TOOLS.has(tool) ? fileFromToolInput(block.input) : null;
      const named = block.files && block.files.length > 0
        ? block.files
        : fromInput === null ? [] : [fromInput];
      if (named.length === 0) continue;
      const into = writes ? written : read;
      for (const file of named) into.add(file);
    }
  }
  return { filesRead: [...read], filesWritten: [...written] };
}
