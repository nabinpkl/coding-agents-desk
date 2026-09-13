// Listing directories so the panel can offer a folder picker.
//
// A browser cannot pick a directory on this machine: `<input webkitdirectory>` hands the page the
// files inside a folder, never the folder's own path, and nothing in the web platform will name an
// absolute path to a page. So the picker has to be served -- the sidecar lists, the panel draws.
//
// **Confined to the home directory, and that is a security boundary rather than a convenience.**
// The sidecar has no authentication of any kind; what stands in for it is the bind address plus
// WireGuard. Registered workspace roots already expose their file CONTENTS, but this route is
// different in kind: it is filesystem enumeration, and an unconfined one would let anyone who can
// reach the sidecar walk the whole disk reading directory names. Home is where projects live, so
// the confinement costs nothing the picker needed, and a path outside it can still be registered by
// naming it, which is a deliberate act rather than a walk.

import { readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { WorkspaceBrowseListing } from "@agentdesk/agent-feed-wire";
import { WorkspaceFailure } from "@/workspace/workspacePaths";


function withinRoot(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}/`);
}

/**
 * The directories inside `path`.
 *
 * Symlinks are resolved before the confinement check rather than after, because a link inside home
 * pointing at `/` would otherwise pass a check on the name it was asked about and then list
 * somewhere else entirely.
 *
 * `confinedTo` is a parameter rather than read here so the confinement itself is testable against a
 * scratch directory. Reading `homedir()` inside would make every test either a test of this
 * machine's home or no test of the boundary at all.
 */
export async function browseDirectories(
  path: string | null,
  confinedTo: string = homedir(),
): Promise<WorkspaceBrowseListing> {
  const root = await realpath(confinedTo);
  const asked = path ? resolve(path) : root;

  let resolved: string;
  try {
    resolved = await realpath(asked);
  } catch {
    throw new WorkspaceFailure("notFound");
  }
  if (!withinRoot(resolved, root)) throw new WorkspaceFailure("forbidden");

  const info = await stat(resolved).catch(() => null);
  if (!info?.isDirectory()) throw new WorkspaceFailure("notDirectory");

  const listed = await readdir(resolved, { withFileTypes: true }).catch(() => {
    // An unreadable directory is an empty one here. The reader can see they are in it and go back
    // up, which beats an error that makes the whole picker look broken.
    return [];
  });

  const entries = listed
    // Symlinks are left out rather than followed, because `workspaceStore.add` refuses a
    // symlinked root -- a picker that offered one would be offering a choice the next step
    // declines, and the reader would have no way to tell which of their folders were real.
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => ({ name: entry.name, path: join(resolved, entry.name) }))
    // Dot-directories last rather than hidden: `.config` holds real projects for some people, and a
    // picker that silently omits a folder the reader can see in Finder reads as broken.
    .sort((left, right) => {
      const leftDot = left.name.startsWith(".");
      const rightDot = right.name.startsWith(".");
      if (leftDot !== rightDot) return leftDot ? 1 : -1;
      return left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
    });

  return {
    path: resolved,
    parent: resolved === root ? null : dirname(resolved),
    entries,
  };
}
