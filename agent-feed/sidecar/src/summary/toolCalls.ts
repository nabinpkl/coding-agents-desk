// What a tool call in a transcript actually DID, in one line, and whether it changed a file.
//
// One module rather than two because both answers read the same field of the same block, and
// splitting them is how the two drift: a new write tool taught to the file extractor but not to
// the renderer would show up in the file list and be invisible in the transcript the model
// reads, which is the one place it would need to be to be explained.
//
// The shapes here are the harnesses' own, and they are not guesses: Claude records `Edit` with
// `file_path`/`old_string`/`new_string` and `Write` with `file_path`/`content` (the panel's
// `DiffBlock` renders from exactly those), and Codex records `apply_patch` with a `file_path`
// and `shell` with a `command`. Anything unrecognised still renders -- by name, with its
// arguments compacted -- because a tool this file has never heard of is still work the turn did.

import type { SummaryFileAction, SummaryFileChange } from "@agentdesk/agent-feed-wire";
import type { ActivityBlock, ActivityEvent } from "@/transcripts/transcriptTypes";

/** How much of one argument is worth showing. A `content` payload is a whole file. */
const ARGUMENT_CHARS = 300;

/** Tools that change a file, and which argument names the path. */
const WRITE_TOOLS: Record<string, SummaryFileAction> = {
  Write: "wrote",
  Edit: "edited",
  MultiEdit: "edited",
  NotebookEdit: "edited",
  apply_patch: "edited",
};

const PATH_KEYS = ["file_path", "filePath", "path", "notebook_path"];

/** One recorded change to one file, before same-path calls are folded together. */
interface FileEdit {
  path: string;
  action: SummaryFileAction;
  added: number;
  removed: number;
}

/**
 * Every file this turn wrote or edited, newest call last, folded per path.
 *
 * A file written and then edited twice is one entry saying `wrote` with three edits, not three
 * entries: the question a viewer has is "which files did this turn change", and the first action
 * is the one that says whether it was created here.
 */
export function filesTouchedIn(events: readonly ActivityEvent[], project: string): SummaryFileChange[] {
  const byPath = new Map<string, SummaryFileChange>();
  for (const event of events) {
    for (const block of event.blocks) {
      const edit = fileEditOf(block, project);
      if (!edit) continue;
      const existing = byPath.get(edit.path);
      if (existing) {
        existing.edits += 1;
        existing.added += edit.added;
        existing.removed += edit.removed;
        continue;
      }
      byPath.set(edit.path, {
        path: edit.path,
        action: edit.action,
        edits: 1,
        added: edit.added,
        removed: edit.removed,
      });
    }
  }
  return [...byPath.values()];
}

/** The file this block changed, or null if it changed none. */
function fileEditOf(block: ActivityBlock, project: string): FileEdit | null {
  if (block.kind !== "tool_use" || !block.tool) return null;
  const action = WRITE_TOOLS[block.tool];
  if (!action) return null;
  const input = block.input ?? {};
  const path = PATH_KEYS.map((key) => input[key]).find(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  if (!path) return null;

  const before = stringArgument(input, ["old_string", "old_text"]);
  const after = stringArgument(input, ["new_string", "new_text", "content", "new_source"]);
  return {
    path: relativeToProject(path, project),
    action,
    // Counted from the payload the harness recorded, which is the only place a transcript says
    // how big a change was. A call that carried no text counts zero rather than guessing.
    added: lineCount(after),
    removed: lineCount(before),
  };
}

function stringArgument(input: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string") return value;
  }
  return "";
}

function lineCount(text: string): number {
  if (!text) return 0;
  return text.split("\n").length;
}

/**
 * A path inside the project, named relative to it.
 *
 * The harnesses record absolute paths, so left alone a digest's file list is a column of
 * `/Users/<someone>/projects/<repo>/` with the part that differs pushed off the right edge. A
 * path OUTSIDE the checkout keeps its absolute form: a turn that wrote to `/tmp` did something
 * worth seeing in full.
 */
function relativeToProject(path: string, project: string): string {
  const root = project.endsWith("/") ? project : `${project}/`;
  return path.startsWith(root) ? path.slice(root.length) : path;
}

/**
 * What a call did, as one line for the model to read.
 *
 * Named arguments first and in a fixed order, because what a viewer -- and a summarizer -- needs
 * from a tool call is the verb and the object: which file, which command, which pattern. The
 * rest of the payload is dropped rather than compacted, since a truncated JSON blob costs the
 * same context as a readable line and says less.
 */
export function describeToolCall(block: ActivityBlock): string {
  const name = block.tool ?? "tool";
  const input = block.input ?? {};
  const parts: string[] = [];

  const path = PATH_KEYS.map((key) => input[key]).find((value): value is string => typeof value === "string");
  if (path) parts.push(path);

  for (const key of ["command", "pattern", "query", "url", "prompt", "description"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) parts.push(`${key}=${clip(value.trim())}`);
  }

  // A write's size, not its contents: the transcript already showed what was written if it
  // mattered, and a summarizer does not need the file to say the file was written.
  const after = stringArgument(input, ["new_string", "new_text", "content", "new_source"]);
  const before = stringArgument(input, ["old_string", "old_text"]);
  if (after || before) parts.push(`+${lineCount(after)}/-${lineCount(before)} lines`);

  if (parts.length === 0 && block.summary) {
    // The adapters already write a label for calls with no argument this file recognises, and an
    // MCP tool's label leads with its own name. Prefixing it again produced
    // `mcp__x__javascript_tool mcp__x__javascript_tool javascript_exec` on every such call.
    const summary = clip(block.summary);
    return summary.startsWith(name) ? summary : `${name} ${summary}`;
  }
  return parts.length > 0 ? `${name} ${parts.join(" ")}` : name;
}

function clip(text: string): string {
  const single = text.replace(/\s+/g, " ");
  return single.length > ARGUMENT_CHARS ? `${single.slice(0, ARGUMENT_CHARS)}…` : single;
}
