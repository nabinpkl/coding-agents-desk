import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Make a directory that every login session on this Mac can write into.
 *
 * Two sessions run their own sidecar as their own user, and both have to leave files where the
 * other can read them: descriptors on the rendezvous board, diagnostics beside them. A directory
 * created with a normal umask belongs to whichever session started first, and the second one's
 * writes then fail on permissions -- which is how a session ends up running with no evidence at
 * all while its numbers are read off the other session's file.
 *
 * Both the parent and the directory itself are forced world-writable-sticky. chmod only works on a
 * directory this user owns, so the throw is expected when another session made it, and means it is
 * already theirs to keep permissive.
 */
export function ensureCrossSessionDirectory(dir: string): void {
  mkdirSync(dir, { recursive: true });
  for (const directory of [dirname(dir), dir]) {
    try {
      chmodSync(directory, 0o1777);
    } catch {
      // owned by another session; assume already permissive
    }
  }
}
