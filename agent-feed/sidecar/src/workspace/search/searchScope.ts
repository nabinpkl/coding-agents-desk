// What the IDE's two searches look at, decided once.
//
// Quick open lists files and the Search section looks inside them, and both run `rg` over the
// same root with the same flags. One definition because the two disagreeing is a visible bug: a
// file quick open offers that text search never finds, or the reverse.

/**
 * Names never searched, at any depth.
 *
 * VS Code's `files.exclude` and `search.exclude` defaults, merged. `.gitignore` already covers
 * `node_modules` in nearly every repository, and this list is for the rest: a workspace that is a
 * parent folder of several projects, and a scratch directory nobody wrote an ignore file for.
 * Measured 2026-09-30 on `~/projects`: 7,247 of its 24,852 listed files were one unignored
 * `node_modules`, which is the case a `.gitignore`-only scope gets wrong.
 */
export const EXCLUDED_NAMES = [
  ".git",
  ".hg",
  ".svn",
  "CVS",
  ".DS_Store",
  "Thumbs.db",
  "node_modules",
  "bower_components",
] as const;

/** Files larger than this are skipped by text search: minified bundles, data dumps, lockfiles. */
export const MAXIMUM_SEARCHED_FILE_SIZE = "2M";

/**
 * The flags every search starts with.
 *
 * - `--no-config`: a `RIPGREP_CONFIG_PATH` in the sidecar's environment must not change what the
 *   panel is shown, and a config file can add flags like `--pre` that run programs.
 * - `--hidden`: dotfiles are part of a project (`.github/`, `.env.example`); `.git` itself is
 *   excluded by name below.
 * - `--no-require-git`: honour `.gitignore` even where there is no `.git`. The oracle peer runs
 *   from a shipped copy of this repository with no `.git`, and without this every ignored file
 *   in it is listed.
 * - `--no-ignore-parent`, which the flag above cannot go without: once `rg` stops asking for a
 *   repository it reads ignore files in every directory ABOVE the root too, up to `/`. This
 *   Mac's `~/.gitignore` is the single line `*`, and with it every workspace listed zero files
 *   (measured 2026-09-30). Only what is inside the workspace decides what is in it. The cost is
 *   a workspace rooted below its repository's top, which no longer sees the top's `.gitignore`.
 * - Symlinks are not followed, which is `rg`'s default and the same rule the file viewer keeps:
 *   an entry that would be refused on open has no business being offered.
 */
export function scopeArguments(): string[] {
  return [
    "--no-config",
    "--hidden",
    "--no-require-git",
    "--no-ignore-parent",
    ...EXCLUDED_NAMES.map((name) => `--glob=!${name}`),
  ];
}

/**
 * A path as `rg` printed it, relative to the root.
 *
 * Every search passes `.` as its path, never nothing: with no path and a non-terminal stdin, `rg`
 * searches stdin instead of the directory. So each result arrives as `./src/x.ts`.
 */
export function relativePath(printed: string): string {
  return printed.startsWith("./") ? printed.slice(2) : printed;
}
