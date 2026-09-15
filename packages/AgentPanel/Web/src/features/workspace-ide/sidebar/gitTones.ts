// What a git status letter means to the eye: which colour a tree row wears, and which group a
// changed file is filed under.
//
// Ported from `ideModel.ts`, which was untyped. The rules are git's, not ours, and getting them
// wrong shows up as a file quietly filed in the wrong section rather than as an error.

import type { WorkspaceGitEntry } from "@agentdesk/agent-feed-wire";

export type GitTone = "modified" | "added" | "deleted" | "untracked" | "conflicted" | "ignored";

/**
 * Porcelain's unmerged combinations.
 *
 * Both columns carry a letter, so without this a conflict would be filed under both Staged and
 * Changes. It is one thing to resolve, not two edits.
 */
const CONFLICT_CODES = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

const STATUS_TONES: Record<string, GitTone> = {
  M: "modified",
  R: "modified",
  C: "modified",
  T: "modified",
  A: "added",
  D: "deleted",
  U: "conflicted",
  "?": "untracked",
};

/** Highest severity first, so a two-letter code collapses to the meaning that matters. */
const TONE_SEVERITY = ["U", "M", "A", "D"];

/**
 * What each tone looks like on a status badge.
 *
 * Beside the tones rather than beside either drawer of them, because two now draw this badge -- the
 * source-control list and the history popup's file rows -- and a deleted file that is rose in one
 * place and amber in the other is the drift a second copy produces.
 *
 * Every state tints except conflict, which fills: a conflict blocks work, so it is the one that
 * should stop the eye. Its label takes the page background rather than white, staying legible in
 * both themes.
 */
export const TONE_BADGE: Record<GitTone, string> = {
  modified: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  added: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  deleted: "bg-rose-500/15 text-rose-600 dark:text-rose-400",
  untracked: "bg-sky-500/15 text-sky-600 dark:text-sky-400",
  conflicted: "bg-fuchsia-600 text-background",
  ignored: "bg-muted text-muted-foreground",
};

export function gitStatusTone(letter: string): GitTone {
  return STATUS_TONES[letter] ?? "modified";
}

/**
 * The decoration a tree row wears.
 *
 * Ignored wins outright: those rows are dimmed rather than badged, because "excluded from the
 * repo" is not a change the reader can act on.
 */
export function gitDecorationTone(status: string | null): GitTone | null {
  const code = (status ?? "").trim();
  if (!code) return null;
  if (code.includes("!")) return "ignored";
  if (CONFLICT_CODES.has(code)) return "conflicted";
  if (code.includes("?")) return "untracked";
  const letter = TONE_SEVERITY.find((candidate) => code.includes(candidate));
  return letter ? gitStatusTone(letter) : "modified";
}

export interface SourceControlRow {
  path: string;
  name: string;
  directory: string;
  letters: string;
  tone: GitTone;
}

export interface SourceControlSection {
  id: "conflicts" | "staged" | "changes" | "untracked";
  title: string;
  rows: SourceControlRow[];
}

function row(path: string, letters: string, tone: GitTone): SourceControlRow {
  const cut = path.lastIndexOf("/");
  return {
    path,
    name: cut < 0 ? path : path.slice(cut + 1),
    directory: cut < 0 ? "" : path.slice(0, cut),
    letters,
    tone,
  };
}

/**
 * Group working-tree entries the way they are resolved.
 *
 * Conflicts first, then what is staged, then unstaged edits, then new files. A path edited both in
 * the index and the worktree appears under both, which is the truth git reports and what the
 * reader has to act on twice. Ignored paths are dropped: they are on the wire only to dim the
 * explorer.
 */
export function sourceControlSections(
  entries: readonly WorkspaceGitEntry[],
): SourceControlSection[] {
  const conflicts: SourceControlRow[] = [];
  const staged: SourceControlRow[] = [];
  const changes: SourceControlRow[] = [];
  const untracked: SourceControlRow[] = [];

  for (const entry of entries) {
    const path = entry.relativePath;
    if (!path) continue;
    const index = entry.indexStatus ?? "";
    const workTree = entry.workTreeStatus ?? "";
    if (workTree === "!" || index === "!") continue;
    if (CONFLICT_CODES.has(`${index}${workTree}`)) {
      conflicts.push(row(path, `${index}${workTree}`, "conflicted"));
      continue;
    }
    if (workTree === "?") {
      untracked.push(row(path, "?", "untracked"));
      continue;
    }
    if (index) staged.push(row(path, index, gitStatusTone(index)));
    if (workTree) changes.push(row(path, workTree, gitStatusTone(workTree)));
  }

  return ([
    { id: "conflicts", title: "Merge Conflicts", rows: conflicts },
    { id: "staged", title: "Staged Changes", rows: staged },
    { id: "changes", title: "Changes", rows: changes },
    { id: "untracked", title: "Untracked", rows: untracked },
  ] as SourceControlSection[]).filter((section) => section.rows.length > 0);
}

/**
 * How many FILES git has something to say about.
 *
 * Distinct paths, not rows. A file edited in the index and again in the worktree is two rows in
 * the section list, because it is two things to act on, but it is one file -- and a badge that
 * said two where `git status` says one would be reporting on the sections rather than on the
 * repository. Ignored paths are on the wire only to dim the explorer, so they are not changes.
 */
export function changedFileCount(entries: readonly WorkspaceGitEntry[]): number {
  const paths = new Set<string>();
  for (const entry of entries) {
    const path = entry.relativePath;
    if (!path) continue;
    if (entry.indexStatus === "!" || entry.workTreeStatus === "!") continue;
    paths.add(path);
  }
  return paths.size;
}

/**
 * The count as a sentence, for the labels that carry a badge's meaning to a screen reader.
 *
 * Here rather than beside either caller because two of them now say it -- the sidebar's section
 * tab and the status bar's branch -- and a count that reads "1 changed files" in one place and
 * not the other is exactly the drift a second copy produces.
 */
export function changedLabel(count: number): string {
  return `${count} changed ${count === 1 ? "file" : "files"}`;
}
