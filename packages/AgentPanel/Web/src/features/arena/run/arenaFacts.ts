// The arithmetic a side-by-side reading needs, kept apart from any component that draws it.
//
// A comparison is only as good as its alignment. Two contestants that read `README.md` record two
// different absolute paths -- each under its own worktree -- so a file matrix built from the raw
// paths would list every shared file once per lane and line nothing up. Everything here turns a
// contestant's facts into values that mean the same thing in every lane: paths relative to the
// contestant's own worktree, diffs split per file with their own line counts, durations on one
// scale.

import type { ArenaContestantDetail } from "@agentdesk/agent-feed-wire";

/**
 * A path as the contestant's repository sees it: relative to its worktree when it lies inside
 * one, untouched when it does not (a file a contestant read from outside its checkout is a fact
 * worth showing whole). macOS answers `/tmp` as `/private/tmp`, and a harness may record either
 * spelling, so both are tried.
 */
export function relativeToWorktree(path: string, worktreePath: string): string {
  const roots = [worktreePath, `/private${worktreePath}`, worktreePath.replace(/^\/private/, "")];
  for (const root of roots) {
    const prefix = root.endsWith("/") ? root : `${root}/`;
    if (path.startsWith(prefix)) return path.slice(prefix.length);
  }
  return path;
}

export type FileTouch = "read" | "written" | "both";

/** One row of the file matrix: a path, and what each contestant did with it (absent = nothing). */
export interface FileRow {
  path: string;
  /** Inside some contestant's worktree, as opposed to a file read from elsewhere on the machine. */
  inRepository: boolean;
  touches: (FileTouch | null)[];
}

/**
 * Every file any contestant touched, one row each, with what each lane did to it.
 *
 * Ordered so the rows a reader compares first come first: files inside the repository before
 * files outside it, then the files more lanes touched, then by path. Ties broken by path so the
 * order is stable while a run is still filling in.
 */
export function fileMatrix(contestants: readonly ArenaContestantDetail[]): FileRow[] {
  const rows = new Map<string, FileRow>();
  contestants.forEach((contestant, lane) => {
    const mark = (absolute: string, touch: "read" | "written"): void => {
      const path = relativeToWorktree(absolute, contestant.worktreePath);
      const inRepository = path !== absolute;
      const row = rows.get(path) ?? {
        path,
        inRepository,
        touches: contestants.map(() => null),
      };
      row.inRepository = row.inRepository || inRepository;
      const current = row.touches[lane];
      row.touches[lane] = current === null || current === undefined || current === touch ? touch : "both";
      rows.set(path, row);
    };
    for (const file of contestant.filesRead) mark(file, "read");
    for (const file of contestant.filesWritten) mark(file, "written");
  });
  const touched = (row: FileRow) => row.touches.filter((one) => one !== null).length;
  return [...rows.values()].sort(
    (a, b) =>
      Number(b.inRepository) - Number(a.inRepository) || touched(b) - touched(a) || a.path.localeCompare(b.path),
  );
}

/** One file's part of a unified `git diff`, with its own line counts. */
export interface DiffFilePart {
  path: string;
  /** The `diff --git` section for this file alone, which the diff viewer renders as one file. */
  text: string;
  added: number;
  removed: number;
}

/**
 * Splits a `git diff` into its files and counts each one's added and removed lines.
 *
 * Counted from the hunk bodies, never from the `+++`/`---` headers, which also start with the
 * marker characters. A truncated diff (the sidecar caps it) keeps whatever whole lines it has;
 * the truncation note is not a hunk line and counts as neither.
 */
export function splitDiff(diff: string): DiffFilePart[] {
  const parts: DiffFilePart[] = [];
  let current: DiffFilePart | null = null;
  let inHunk = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const named = / b\/(.+)$/.exec(line);
      current = { path: named?.[1] ?? line.slice(11), text: line, added: 0, removed: 0 };
      parts.push(current);
      inHunk = false;
      continue;
    }
    if (!current) continue;
    current.text += `\n${line}`;
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("+")) current.added += 1;
    else if (line.startsWith("-")) current.removed += 1;
  }
  return parts;
}

/** A whole diff's line counts, the number a facts row compares across lanes. */
export function diffStat(diff: string | null): { added: number; removed: number; files: number } {
  const parts = diff ? splitDiff(diff) : [];
  return {
    added: parts.reduce((sum, part) => sum + part.added, 0),
    removed: parts.reduce((sum, part) => sum + part.removed, 0),
    files: parts.length,
  };
}

/**
 * How long a contestant has run: its recorded duration once closed, the live elapsed time while
 * it runs (from `now`), nothing before it started.
 */
export function elapsedMs(contestant: ArenaContestantDetail, now: number): number | null {
  if (contestant.durationMs !== null) return contestant.durationMs;
  if (contestant.startedAt === null) return null;
  return Math.max(0, (contestant.closedAt ?? now) - contestant.startedAt);
}

/** A duration at the precision a rough fact deserves: tenths under a minute, then m:ss. */
export function formatDuration(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/** A count of tokens as a reader scans it: 20.9k rather than 20858. */
export function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  return `${(tokens / 1000).toFixed(tokens < 10_000 ? 1 : 0)}k`;
}

/** When a run was made, relative to now, for the run list. */
export function formatAgo(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** The last path segment, which is how a repository is named in a dense row. */
export function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1) || trimmed;
}
