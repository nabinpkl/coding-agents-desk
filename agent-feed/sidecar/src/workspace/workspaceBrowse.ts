// Listing and creating directories so the panel can offer a folder picker.
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

import { mkdir, readdir, realpath, stat } from "node:fs/promises";
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

/**
 * The name of a folder to create, refused before it reaches the filesystem.
 *
 * One segment and nothing else. A name carrying a separator would create somewhere other than
 * where the reader is looking, and `..` would create above it -- which is exactly the walk the
 * confinement above exists to refuse, asked for in a form that looks like a name.
 */
function folderName(name: string): string {
  const trimmed = name.trim();
  if (trimmed === "" || trimmed === "." || trimmed === "..") {
    throw new WorkspaceFailure("invalidPath");
  }
  if (trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("\0")) {
    throw new WorkspaceFailure("invalidPath");
  }
  return trimmed;
}

/**
 * Create a folder inside `parent` and hand back the listing of what now exists.
 *
 * Here beside `browseDirectories` because the picker needs both and they share one confinement: a
 * route that could make a directory anywhere could put one anywhere the reader cannot browse, so
 * the two would have to agree about where the edge is or the picker would be a hole in its own
 * wall.
 *
 * The parent is resolved and checked exactly as a browse resolves it -- symlinks included, since
 * `mkdir` through a link inside home would otherwise write outside it. `recursive: false` is the
 * point of the whole function: a name that already exists is the reader's most common outcome and
 * is refused as `nameTaken` rather than quietly accepted as a directory that was already there.
 */
export async function createDirectory(
  parent: string,
  name: string,
  confinedTo: string = homedir(),
): Promise<WorkspaceBrowseListing> {
  const wanted = folderName(name);
  const root = await realpath(confinedTo);
  const asked = resolve(parent);

  let resolvedParent: string;
  try {
    resolvedParent = await realpath(asked);
  } catch {
    throw new WorkspaceFailure("notFound");
  }
  if (!withinRoot(resolvedParent, root)) throw new WorkspaceFailure("forbidden");

  const info = await stat(resolvedParent).catch(() => null);
  if (!info?.isDirectory()) throw new WorkspaceFailure("notDirectory");

  const created = join(resolvedParent, wanted);
  try {
    await mkdir(created);
  } catch (error) {
    // The one errno this route exists to report, named rather than folded into "something went
    // wrong": a reader who has just typed a name needs to know it is taken, not that creation
    // failed.
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new WorkspaceFailure("nameTaken");
    throw error;
  }
  // The listing of the new folder rather than its path, so the panel can stand in it without a
  // second round trip and cannot show a path the filesystem did not resolve to that.
  return browseDirectories(created, confinedTo);
}
