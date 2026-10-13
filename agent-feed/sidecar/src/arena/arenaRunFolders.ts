// A run's name, and the folder in the arena home that the name gives it.
//
// Every run has a folder of its own, `<arenaHome>/<folder name>`, and the contestants' worktrees
// are made in it as `c1`, `c2`, ... A run that names no repository gets the folder itself as a new
// repository, so its worktrees sit inside the checkout they belong to. The name is the reader's,
// "arena run N" when they gave none; the folder name is that name made safe for a path, and the
// folder existing is what makes a name taken: two runs cannot share a folder, so they cannot share
// a name either, and a folder whose run record was lost still holds its name.

import { mkdirSync, readdirSync, rmdirSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const DEFAULT_NAME = /^arena run (\d+)$/i;
const DEFAULT_FOLDER = /^arena-run-(\d+)$/;
const FOLDER_SHAPE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAXIMUM_RUN_NAME_LENGTH = 80;

/** The folder a name gives its run: lower case, each run of anything but letters and digits one hyphen. */
export function runFolderName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 64)
    .replace(/^-+|-+$/g, "");
}

/**
 * The name a run asked for, its spaces collapsed, or the next default when it asked for none --
 * with the folder it gives; or why the run cannot have it. A name whose folder name another run
 * already has is refused here, before its folder is looked for.
 */
export function runNameFor(
  asked: unknown,
  home: string,
  names: readonly string[],
): { name: string; folderName: string } | { problem: string } {
  const trimmed = typeof asked === "string" ? asked.trim().replace(/\s+/g, " ") : "";
  const name = trimmed || nextRunName(home, names);
  if (name.length > MAXIMUM_RUN_NAME_LENGTH) {
    return { problem: `a run's name is capped at ${MAXIMUM_RUN_NAME_LENGTH} characters` };
  }
  const folderName = runFolderName(name);
  if (!folderName) return { problem: "a run's name needs at least one letter or digit" };
  if (names.some((taken) => runFolderName(taken) === folderName)) {
    return { problem: `there is already a run named like "${name}"; name this one something else` };
  }
  return { name, folderName };
}

/** One past the highest "arena run N" among the runs' names and the home's folders. */
export function nextRunName(home: string, names: readonly string[]): string {
  let highest = 0;
  for (const name of names) {
    const match = DEFAULT_NAME.exec(name.trim());
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  for (const folder of foldersIn(home)) {
    const match = DEFAULT_FOLDER.exec(folder);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return `arena run ${highest + 1}`;
}

function foldersIn(home: string): string[] {
  try {
    return readdirSync(home);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/**
 * Makes the run's folder, which is what claims its name: the path, or null when the folder is
 * already there. Made without `recursive` so two runs asking for one name at once cannot both win.
 */
export function claimRunFolder(home: string, folderName: string): string | null {
  if (!FOLDER_SHAPE.test(folderName)) throw new Error(`"${folderName}" is not a run folder name`);
  mkdirSync(home, { recursive: true });
  const path = join(home, folderName);
  try {
    mkdirSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
    throw error;
  }
  return path;
}

/**
 * Removes a run's folder once its worktrees are gone. A folder the arena made into the run's own
 * repository goes whole, repository and all; a folder that only held worktrees of a repository
 * the run named must be empty by now, and one that is not is refused rather than emptied.
 *
 * Only a folder directly in the home with a run folder's name is ever removed, so a corrupt
 * record cannot point this anywhere else.
 */
export function releaseRunFolder(home: string, path: string, repoCreated: boolean): void {
  if (dirname(path) !== home || !FOLDER_SHAPE.test(basename(path))) {
    throw new Error(`${path} is not a run folder in ${home}`);
  }
  if (repoCreated) rmSync(path, { recursive: true, force: true });
  else rmdirSync(path);
}
