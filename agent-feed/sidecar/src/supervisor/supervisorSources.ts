// Which files this supervisor is itself built from.
//
// It watches the whole sidecar tree and replaces the CHILD when that tree moves, which leaves one
// file it cannot act on: its own. A change to `supervisor.ts` or anything it imports used to sit
// there running the old code and looking exactly like the new code, until somebody relaunched the
// host -- and the thing it was most likely to be wrong about was the rule for when to restart.
//
// Computed rather than listed, because a list goes stale the first time somebody adds an import and
// the staleness is silent: the supervisor would go on running code it had already been told to
// replace, which is the failure this whole file exists to end.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The alias every local import in this tree uses. Relative ones are refused, so this is all. */
const LOCAL = "@/";

/**
 * Everything reachable from `entry` by local imports, `entry` included.
 *
 * Only `@/` specifiers are followed: relative imports are refused in both trees here (checked by
 * `tools/agent-feed-fitness.sh`), so every local module is reachable that way and everything else
 * is a package this process cannot replace itself over anyway.
 *
 * A file that cannot be read contributes nothing rather than throwing. This runs at startup, and a
 * supervisor that refuses to start because one import was mid-write would be a worse bargain than
 * one that watches a slightly smaller set.
 */
export function ownSources(entry: string, root: string): Set<string> {
  const transpiler = new Bun.Transpiler({ loader: "tsx" });
  const found = new Set<string>();
  const queue = [entry];

  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || found.has(file)) continue;
    found.add(file);

    let source: string;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      continue;
    }

    let imports: { path: string }[];
    try {
      imports = transpiler.scanImports(source);
    } catch {
      // Half a file imports nothing yet. The watcher will come back when it is whole.
      continue;
    }

    for (const imported of imports) {
      if (!imported.path.startsWith(LOCAL)) continue;
      const resolved = resolve(imported.path, root);
      if (resolved !== null) queue.push(resolved);
    }
  }

  return found;
}

/** `@/foo/bar` under this root, with the extension the file actually has. */
function resolve(specifier: string, root: string): string | null {
  const base = join(root, specifier.slice(LOCAL.length));
  for (const candidate of [`${base}.ts`, `${base}.tsx`]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}
