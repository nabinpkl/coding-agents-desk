// Every file in a workspace, for quick open.
//
// `rg --files` rather than `git ls-files`: the two answer alike inside one repository (2,945 and
// 2,912 files in about 30ms each on this one, measured 2026-09-30), but a workspace that is a
// parent folder of several projects is not a repository, and there git answers nothing while `rg`
// still honours each project's own `.gitignore`.

import { relativePath, scopeArguments } from "@/workspace/search/searchScope";
import { runRipgrep } from "@/workspace/search/ripgrep";

/**
 * The most paths one answer carries.
 *
 * About 3MB of JSON at this repository's average path length, which is as much as is worth sending
 * to a phone for a picker; the largest folder measured here listed 17,605.
 */
export const MAXIMUM_LISTED_FILES = 50_000;

export async function listFiles(
  binary: string | null,
  root: string,
  signal?: AbortSignal,
): Promise<{ files: string[]; truncated: boolean }> {
  const files: string[] = [];
  let truncated = false;
  await runRipgrep(
    binary,
    [...scopeArguments(), "--files", "--null", "."],
    root,
    (record) => {
      if (files.length >= MAXIMUM_LISTED_FILES) {
        truncated = true;
        return false;
      }
      files.push(relativePath(record));
      return true;
    },
    { separator: "\0", signal },
  );
  // `rg` walks on every core, so its order is whichever thread finished first. Sorted here so two
  // openings of the picker offer the same list in the same order.
  files.sort();
  return { files, truncated };
}
