// Which directories a Bot may be bound to.
//
// A Bot is a directory and the sessions working in it, and until now the directory had to be one
// the catalog already knew -- meaning at least one agent session had already run there. That is the
// wrong way round for the case the panel's folder picker exists to serve: binding a Bot to a
// project nobody has started a session in yet, which is precisely when naming it and launching its
// first turn in one act is worth something.
//
// So the rule is "a directory this machine actually has", with the catalog kept as the first
// answer rather than the only one. Two details are deliberate:
//
// **Confined to the home directory**, matching `workspaceBrowse.ts`, which is what the picker lists
// from. The sidecar has no authentication -- the tailnet is the boundary -- and `add_bot` is a
// grant an agent can hold, so the accept side is kept as narrow as the enumerate side rather than
// letting a caller name any path on the disk. A catalog directory is accepted wherever it lives,
// because a session already ran there and nothing here made that true.
//
// **The real path is what gets bound.** A session reports the directory it is actually in, so a Bot
// bound to a symlink would never see the sessions working inside it -- they would resolve to a
// different string and attach to nothing.

import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";

function withinRoot(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}/`);
}

/**
 * The directory to bind, or undefined when this machine has nothing to bind.
 *
 * `inCatalog` and `confinedTo` are parameters rather than read here so the boundary is testable
 * against a scratch directory: reading `homedir()` inside would make every test either a test of
 * this machine's home or no test of the confinement at all.
 */
export function bindableDirectory(
  path: string,
  inCatalog: (path: string) => boolean,
  confinedTo: string = homedir(),
): { projectPath: string } | undefined {
  if (inCatalog(path)) return { projectPath: path };
  try {
    const root = realpathSync(confinedTo);
    const resolved = realpathSync(path);
    if (!withinRoot(resolved, root)) return undefined;
    return statSync(resolved).isDirectory() ? { projectPath: resolved } : undefined;
  } catch {
    // A path that cannot be resolved is one this machine does not have, which is the same answer
    // as a path outside home: nothing to bind.
    return undefined;
  }
}
