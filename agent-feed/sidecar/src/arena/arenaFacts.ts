// The facts a contestant's own events say: which files its tools read and which they wrote, and
// where outside its own worktree they reached.
//
// Read off the events exactly once, here, whichever harness produced them, which is why a run's
// file facts mean the same thing for an opencode contestant and a Claude one.

import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ArenaOutsideReach } from "@agentdesk/agent-feed-wire";
import type { ActivityEvent } from "@/transcripts/transcriptTypes";

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
    for (const block of event.blocks) {
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

/** Tools that search a directory, which they name by `path`. */
const SEARCH_TOOLS = new Set(["grep", "glob", "list", "ls"]);
/** Claude's `Bash`, and the opencode serve's `shell` (measured on 2.0.27: its shell call is named so). */
const SHELL_TOOLS = new Set(["bash", "shell"]);

/**
 * Where a reach is not news: the machine's own directories, which every build and shell names
 * (`/usr/bin/env`, `2>/dev/null`, a temp file), and each harness's own scratch for long tool
 * output, which it reads back as part of how it works. Relative to the home where they are in it.
 */
const SYSTEM_ROOTS = [
  "/dev", "/tmp", "/private", "/var", "/usr", "/bin", "/sbin", "/opt", "/etc", "/System", "/Library",
  "/Applications", "/nix",
];
const HARNESS_SCRATCH = [".local/share/opencode/tool-output"];
/** Claude's own spill of a long tool output: `~/.claude/projects/<project>/<session>/tool-results/`. */
const CLAUDE_SPILL_SEGMENT = `${sep}tool-results${sep}`;

/** Most a contestant's list holds: past this it has stopped being a few reaches and is a pattern. */
const MAXIMUM_REACHES = 200;

/**
 * Every place outside `worktreePath` this contestant's tools named, and whose worktree each one
 * is in when it is a rival's.
 *
 * Contestants run as plain agents (ADR-0139), so a read of a rival's work is not refused; this is
 * what makes one visible. File tools are read by the same keys `filesFromEvents` reads, a search
 * tool by the directory it searched, and a shell command by the path-like words in its text --
 * an absolute path, a `~` path, or one climbing with `..` -- resolved against the worktree. That
 * last is a reading of the command, not of what the shell did: a `cd` earlier in the same line is
 * not followed, which is why the climb itself is what gets counted.
 */
export function outsideReaches(
  events: readonly ActivityEvent[],
  where: {
    worktreePath: string;
    rivals: readonly { contestantId: string; worktreePath: string; sessionId: string | null }[];
    home: string;
  },
): ArenaOutsideReach[] {
  const own = resolve(where.worktreePath);
  const seen = new Set<string>();
  const out: ArenaOutsideReach[] = [];
  const note = (raw: string, how: ArenaOutsideReach["how"]): void => {
    const path = resolveNamed(raw, own, where.home);
    if (path === null || within(path, own)) return;
    // A rival's worktree, or its transcript: a Claude rival's session is a file named for it.
    const rival = where.rivals.find((one) =>
      within(path, resolve(one.worktreePath))
      || (one.sessionId !== null && path.endsWith(`${sep}${one.sessionId}.jsonl`))
    )?.contestantId ?? null;
    if (rival === null && expected(path, where.home)) return;
    const key = `${how}\0${path}`;
    if (seen.has(key) || out.length >= MAXIMUM_REACHES) return;
    seen.add(key);
    out.push({ path, how, rival });
  };
  for (const event of events) {
    for (const block of event.blocks) {
      if (block.kind !== "tool_use" || !block.tool) continue;
      const tool = block.tool.toLowerCase();
      const input = block.input && typeof block.input === "object" ? block.input : {};
      if (SHELL_TOOLS.has(tool)) {
        if (typeof input.command === "string") for (const word of pathWords(input.command)) note(word, "shell");
        continue;
      }
      if (SEARCH_TOOLS.has(tool)) {
        if (typeof input.path === "string" && input.path) note(input.path, "search");
        continue;
      }
      const writes = WRITE_TOOLS.has(tool);
      if (!writes && !READ_TOOLS.has(tool)) continue;
      const fromInput = fileFromToolInput(block.input);
      const named = block.files && block.files.length > 0 ? block.files : fromInput === null ? [] : [fromInput];
      for (const file of named) note(file, writes ? "write" : "read");
    }
  }
  return out;
}

/** A named path made absolute: `~` against the home, anything relative against the worktree. */
function resolveNamed(raw: string, own: string, home: string): string | null {
  const word = raw.trim();
  if (!word || word.includes("://")) return null;
  if (word === "~" || word.startsWith("~/")) return resolve(join(home, word.slice(1)));
  return isAbsolute(word) ? resolve(word) : resolve(own, word);
}

function within(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function expected(path: string, home: string): boolean {
  if (HARNESS_SCRATCH.some((scratch) => within(path, join(home, scratch)))) return true;
  if (within(path, join(home, ".claude", "projects")) && path.includes(CLAUDE_SPILL_SEGMENT)) return true;
  if (within(path, home)) return false;
  return SYSTEM_ROOTS.some((root) => within(path, root));
}

/**
 * The words of a shell command that name a path outside where it runs: absolute, `~`, or climbing
 * with `..`. Split on whitespace and the shell's own punctuation, quotes stripped, and an
 * assignment or option read for its value (`--dir=../c1`, `out=/x`).
 */
function pathWords(command: string): string[] {
  const words: string[] = [];
  for (const piece of command.split(/[\s|;&()<>`]+/)) {
    let word = piece.replace(/^['"]+|['"]+$/g, "");
    const assigned = word.indexOf("=");
    if (assigned >= 0) word = word.slice(assigned + 1).replace(/^['"]+|['"]+$/g, "");
    if (word.startsWith("/") || word === "~" || word.startsWith("~/") || word === ".." || word.startsWith("../")
      || word.includes(`${sep}..${sep}`) || word.endsWith(`${sep}..`)) {
      words.push(word);
    }
  }
  return words;
}
