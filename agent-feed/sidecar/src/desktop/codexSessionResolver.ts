import type { DesktopAuditSnapshot, WindowInputReason, WindowTarget } from "@agentdesk/agent-feed-wire";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { config } from "@/config/config";
import type { ProcessRow } from "@/desktop/claudeSessionResolver";

/**
 * Resolves a Codex Desktop thread id to the window showing it.
 *
 * A different problem from Claude's, despite the same shape of answer. Codex Desktop runs one
 * `codex app-server` child for every thread of every window, and no child argv or state file carries
 * the thread id in a window-distinguishing way, so the process tree cannot resolve it. The mapping
 * is the app's OWN state joined to the accessibility tree: the thread's display title and `cwd` come
 * from `~/.codex` state files, and each window exposes either its header-bar identity (thread title
 * button plus `Project:` popup) or the first row of its Recents list.
 *
 * Matching is layered:
 *
 * - A named thread matches the header title AND project together.
 * - A still-generic thread (`New chat` / `New voice chat` / `Untitled`) drops the title requirement
 *   in the header layout: the project popup alone is identity.
 * - Any thread whose display title equals a window's Recents first row matches that window, which is
 *   how a thread opened from Recents -- a `cwd` outside the app's project registry -- resolves.
 *
 * Conversation content is deliberately NOT matched: the app virtualizes its message list, so what is
 * rendered depends on scroll position and can never be a deterministic anchor.
 *
 * Everything here is pure over file text and window summaries, so every case is testable against
 * fixtures with no live app.
 */

/** One row of Codex Desktop's own thread registry, reduced to what resolution needs. */
export interface CodexThreadRecord {
  threadId: string;
  /** The registry's title, which is lowercased and does not match the AX header exactly. */
  title: string;
  cwd: string;
}

/** One window's identity, as the helper's `codex-window-summaries` reports it. */
export interface CodexWindowSummary {
  windowID: number;
  threadTitle: string;
  projectName: string;
  /** First row of the window's Recents list, absent when the layout exposes no list. */
  recentsFirstRow?: string;
  bounds: { x: number; y: number; w: number; h: number };
}

/**
 * Titles Codex Desktop gives a thread that has not been named yet. A thread is auto-titled from its
 * first message, so these are transient, but while they last they cannot disambiguate two windows of
 * the same project.
 */
export const GENERIC_TITLES = new Set(["new chat", "new voice chat", "untitled", ""]);

/** Parses `threads` rows out of `sqlite3 -json`. A malformed row is skipped, never fatal. */
export function parseThreadRows(json: string): CodexThreadRecord[] {
  let rows: unknown;
  try {
    rows = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(rows)) return [];
  const records: CodexThreadRecord[] = [];
  for (const row of rows as { id?: unknown; title?: unknown; cwd?: unknown }[]) {
    if (typeof row.id !== "string" || typeof row.cwd !== "string" || row.cwd.length === 0) continue;
    records.push({
      threadId: row.id,
      title: typeof row.title === "string" ? row.title : "",
      cwd: row.cwd,
    });
  }
  return records;
}

/**
 * Parses `session_index.jsonl`, the app's display-title index.
 *
 * `thread_name` is the title the app SHOWS -- it matches the accessibility header button and the
 * Recents sidebar row exactly, where the registry's `title` is lowercased and does not.
 */
export function parseSessionIndex(text: string): Map<string, string> {
  const names = new Map<string, string>();
  for (const line of text.split("\n")) {
    if (line.length === 0) continue;
    try {
      const entry = JSON.parse(line) as { id?: unknown; thread_name?: unknown };
      if (typeof entry.id !== "string") continue;
      if (typeof entry.thread_name !== "string" || entry.thread_name.length === 0) continue;
      names.set(entry.id, entry.thread_name);
    } catch {
      continue;
    }
  }
  return names;
}

/** The directory name the `Project: <name>` popup shows for a thread's working directory. */
export function projectName(cwd: string): string {
  return basename(cwd);
}

export type CodexWindowMatch =
  | { kind: "matched"; window: CodexWindowSummary }
  /** More than one window matches. Refused rather than guessed. */
  | { kind: "ambiguous" }
  | { kind: "not-found" };

/** Resolves one thread to the unique window showing it, per the layered rules above. */
export function matchWindow(
  title: string,
  cwd: string,
  threadName: string,
  windows: CodexWindowSummary[],
): CodexWindowMatch {
  const project = projectName(cwd);
  const displayName = threadName.length > 0 ? threadName : title;
  const isGeneric = GENERIC_TITLES.has(displayName.toLowerCase());

  const candidates = windows.filter((window) => {
    // Header-bar layout: title AND project together, or project alone for a generic title.
    if (window.projectName.length > 0) {
      if (window.projectName !== project) return false;
      if (isGeneric) return true;
      return (
        (threadName.length > 0 && window.threadTitle === threadName) ||
        (title.length > 0 && window.threadTitle.toLowerCase() === title.toLowerCase())
      );
    }
    // Projects/Recents layout: the window's current thread is pinned as the first row of its Recents
    // list. A named thread matches its display title exactly; a generic thread matches the generic
    // first row, and uniqueness across windows still refuses ambiguity.
    const firstRow = window.recentsFirstRow;
    if (firstRow === undefined || firstRow.length === 0) return false;
    return firstRow === displayName || (title.length > 0 && firstRow.toLowerCase() === title.toLowerCase());
  });

  if (candidates.length === 1) return { kind: "matched", window: candidates[0]! };
  if (candidates.length > 1) return { kind: "ambiguous" };
  return { kind: "not-found" };
}

/**
 * Every live process whose argv is exactly the Codex Desktop main binary, ascending.
 *
 * `ChatGPT.app` hosts Codex Desktop. A wrong pid here degrades to `no-window` at targeting, never to
 * a write against another application.
 */
export function codexMainPids(rows: ProcessRow[], mainPath: string = config.codexDesktopMainPath): number[] {
  return rows
    .filter((row) => row.arguments === mainPath || row.arguments.startsWith(`${mainPath} `))
    .map((row) => row.pid)
    .sort((a, b) => a - b);
}

/**
 * Reads the app's live registry through the system sqlite3 CLI.
 *
 * `-readonly` keeps the read out of the app's write path and harmless to its WAL. A missing or
 * unreadable database means "no such thread", not a failure.
 */
export async function threadRecord(
  threadId: string,
  sqlitePath: string = config.codexStateSqlite,
): Promise<CodexThreadRecord | null> {
  // Doubling embedded quotes is what keeps a thread id from the wire inside the SQL literal.
  const literal = threadId.replaceAll("'", "''");
  const child = Bun.spawn(
    [
      "/usr/bin/sqlite3",
      "-readonly",
      "-json",
      sqlitePath,
      `SELECT id, title, cwd FROM threads WHERE id = '${literal}' LIMIT 1;`,
    ],
    { stdout: "pipe", stderr: "ignore" },
  );
  const text = await new Response(child.stdout as ReadableStream).text();
  if ((await child.exited) !== 0 || text.length === 0) return null;
  return parseThreadRows(text)[0] ?? null;
}

/** The thread's display title from `session_index.jsonl`, empty when absent. */
export function threadName(threadId: string, indexPath: string = config.codexSessionIndex): string {
  try {
    return parseSessionIndex(readFileSync(indexPath, "utf8")).get(threadId) ?? "";
  } catch {
    return "";
  }
}

/**
 * Turns a resolved Codex window into the window and Desktop the composer needs.
 *
 * Unlike Claude, the pid owns several windows and they are told apart by WindowServer's id, which the
 * accessibility scan reads off the window element directly. It used to be a frame comparison with a
 * single-window escape hatch, and both were wrong for the case this exists for: two maximized Codex
 * windows on two Desktops carry the same frame.
 */
export function target(
  sessionId: string,
  mainPid: number,
  windowID: number,
  snapshot: DesktopAuditSnapshot,
): WindowTarget | { reason: WindowInputReason } {
  if (snapshot.activeSpaceID === null || snapshot.diagnostic !== null) {
    return { reason: "placement-unavailable" };
  }
  // Both views name the window by the same id, so this is a lookup rather than a comparison. The pid
  // and layer conditions stay: an id that resolves to another app's window, or to a panel rather than
  // a real window, is a bug worth refusing rather than addressing.
  const window = snapshot.windows.find(
    (candidate) =>
      candidate.windowID === windowID &&
      candidate.ownerPID === mainPid &&
      candidate.layer === 0 &&
      candidate.spaceIDs.length === 1,
  );
  const homeSpaceID = window?.spaceIDs[0];
  if (!window || homeSpaceID === undefined) return { reason: "no-window" };
  return {
    sessionId,
    claudeMainPid: mainPid,
    windowID: window.windowID,
    homeSpaceID,
    activeSpaceID: snapshot.activeSpaceID,
    bounds: window.bounds,
    onActiveDesktop: homeSpaceID === snapshot.activeSpaceID,
  };
}
