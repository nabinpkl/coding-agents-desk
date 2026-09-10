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
