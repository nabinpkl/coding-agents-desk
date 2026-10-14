// Whether the sidecar's tree holds together as a program, not just as files.
//
// The parse gate in `supervisor.ts` answers "is each changed file whole", and a tree can say yes to
// that and still not start. The case that keeps happening is an edit landing in the wrong order: an
// agent saves the caller before the callee, so `server.ts` imports a name that does not exist yet.
// Every file parses, the old sidecar is stopped to free the port, and the new one dies at startup
// on the missing export. Nothing is serving until the next save fixes it, and every stream the
// panel holds is gone in the meantime.
//
// So before a restart the whole import graph is resolved by Bun's bundler, in memory, writing
// nothing. That is the same resolution the runtime does a moment later, and it reports a missing
// export or an unresolvable path by name. Measured 2026-10-14 on this tree: 37 to 126ms, inside the
// supervisor's own settle window.
//
// npm packages are named as external rather than left to `packages: "external"`, which treats
// every bare specifier as a package -- including this project's own `@/` and `@repo/` aliases, so
// the graph it checked was `server.ts` alone (measured: 71 of its imports left unfollowed). Naming
// the dependencies skips only what `bun install` already vouched for.
//
// What it cannot see is code that resolves and then throws while the module loads. That still
// crashes the replacement; this narrows the gap, it does not close it.
//
// The build runs in a CHILD `bun`, never in the supervisor. Measured 2026-10-14: run in-process, it
// froze the supervisor -- main thread parked on a native lock (`_os_unfair_lock_lock_slow`, sampled),
// no heartbeat, no watcher, no restarts -- from the moment files were being moved under it, while
// the sidecar it supervised kept serving stale code with nothing to say so. A child that hangs is
// killed on a timer and reported; the supervisor's own loop never waits on the bundler.

import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Every dependency the sidecar declares, and anything under it.
 *
 * Read once: a dependency added while the supervisor runs needs a `bun install`, which is not a
 * save the supervisor acts on anyway.
 */
export function declaredPackages(sidecarRoot: string): string[] {
  const manifest = JSON.parse(readFileSync(join(sidecarRoot, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const names = [...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.devDependencies ?? {})];
  return names.flatMap((name) => [name, `${name}/*`]);
}

/** Long enough for a cold build of this tree many times over; it takes 40-130ms warm. */
const LINK_TIMEOUT_MS = 10_000;

/**
 * Why the program reached from `entry` will not link, or null when it does -- asked of a child
 * `bun`, so a build that hangs costs that child and not the caller.
 *
 * `command` is the seam: the process to ask, which a test replaces with one that never answers.
 */
export async function linkFailure(
  entry: string,
  external: string[],
  options: { timeoutMs?: number; command?: string[] } = {},
): Promise<string | null> {
  const command = options.command ?? [process.execPath, import.meta.path, entry, JSON.stringify(external)];
  const child = Bun.spawn({ cmd: command, stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, options.timeoutMs ?? LINK_TIMEOUT_MS);
  try {
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (timedOut) return `could not check the import graph: no answer in ${options.timeoutMs ?? LINK_TIMEOUT_MS}ms`;
    if (code !== 0) return `could not check the import graph: ${err.trim().split("\n").pop() || `exit ${code}`}`;
    return JSON.parse(out) as string | null;
  } finally {
    clearTimeout(timer);
  }
}

/** The check itself, which only ever runs in the child (see `linkFailure`). */
async function linkFailureHere(entry: string, external: string[]): Promise<string | null> {
  const result = await Bun.build({ entrypoints: [entry], target: "bun", external, throw: false });
  if (result.success) return null;
  const first = result.logs.find((log) => log.level === "error") ?? result.logs[0];
  if (!first) return "will not link, and Bun gave no reason";
  const where = first.position ? `${first.position.file.split("/").pop()}:${first.position.line}: ` : "";
  return `${where}${shortenPaths(first.message)}`;
}

/**
 * Bun names files relative to the process's working directory, which for the supervisor is wherever
 * the host started it: measured, `"../../../../../../../Users/.../src/supervisorLinks.ts"`. The panel
 * row has one line to spend, so a quoted file path becomes its name. An import specifier such as
 * `"@/nowhere"` is neither relative nor absolute and is left as written, since it IS the finding.
 */
function shortenPaths(message: string): string {
  return message.replace(/"(?:(?:\.\.?\/)+|\/)[^"]*?([^"/]+)"/g, '"$1"');
}

// Run as a script, this file is the child `linkFailure` asks: `bun supervisorLinks.ts <entry> <external as JSON>`.
if (import.meta.main) {
  const [entry, external] = process.argv.slice(2);
  if (!entry || !external) throw new Error("usage: supervisorLinks.ts <entry> <external packages as JSON>");
  console.log(JSON.stringify(await linkFailureHere(entry, JSON.parse(external) as string[])));
}
