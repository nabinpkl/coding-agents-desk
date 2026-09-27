// Which code a sidecar is running, as one short string both ends can compute.
//
// The sidecar hashes its tree once, at startup, and reports it on `/api/config`; the panel's dev
// server hashes the same files in this Mac's working tree now and compares. A difference means the
// sidecar is behind the tree the panel is being served from -- held back by its supervisor, or a
// peer that has not been shipped to -- which is otherwise found out as a 404 from a route the
// panel's code expects and the running sidecar does not have yet.
//
// A content hash rather than a commit: several sessions edit this tree uncommitted all day, and a
// commit id says nothing about which of those edits a process read.
//
// No `@/` imports. The dev server loads this from `vite.config.ts` under Node, where this tree's
// aliases do not exist, so it may use nothing but Node itself.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** The directories under `agent-feed/` a sidecar is built from: its own source and the wire. */
const TREES = ["sidecar/src", "wire"];

/** Source a sidecar runs. Tests are not, and editing one must not read as the sidecar falling behind. */
function counts(path: string): boolean {
  return /\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path);
}

/** Every counted file under `agentFeedRoot`'s trees, relative to it, sorted. */
export function sourceFiles(agentFeedRoot: string): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && counts(path)) found.push(relative(agentFeedRoot, path).split(sep).join("/"));
    }
  };
  for (const tree of TREES) walk(join(agentFeedRoot, tree));
  return found.sort();
}

/**
 * The version of the sidecar source under `agentFeedRoot` (the `agent-feed` directory): twelve hex
 * characters of a sha256 over every counted file's path and contents.
 *
 * Paths are relative and `/`-separated, so a peer's shipped copy of the same files hashes the
 * same wherever its repository sits.
 */
export function sourceVersion(agentFeedRoot: string): string {
  const hash = createHash("sha256");
  for (const file of sourceFiles(agentFeedRoot)) {
    hash.update(file);
    hash.update("\0");
    hash.update(readFileSync(join(agentFeedRoot, file)));
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 12);
}

/**
 * What would make `sourceVersion` answer differently: every counted file's path, size and
 * modification time. Stat-only, so a caller asking often can skip the hash while it has not moved.
 */
export function sourceSignature(agentFeedRoot: string): string {
  return sourceFiles(agentFeedRoot)
    .map((file) => {
      const info = statSync(join(agentFeedRoot, file), { throwIfNoEntry: false });
      return info ? `${file}:${info.size}:${info.mtimeMs}` : file;
    })
    .join("\n");
}
