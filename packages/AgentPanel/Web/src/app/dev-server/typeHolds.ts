// Holding a whole file's update until the code it lands among typechecks.
//
// The parse gate in `panelPublish.ts` stops half a file. It cannot stop a whole file that disagrees
// with the files around it, and that is what an edit across two files looks like between its two
// saves: on 2026-10-16 a hook was saved taking a list of machines while `App` still passed it one
// feed, and the Feed tab went to `all.map is not a function` until the second save landed. So a
// whole file's update waits here for a typecheck of the page's code (TypeScript 7, about a second),
// and is sent only if the tree it lands in has no error it did not already have.
//
// Held per FILE, not per tree, because several agents edit this tree at once and one agent's
// half-finished change must not freeze everybody else's. A waiting file is held only when a new
// error is in it, or in a file that imports it, directly or further up: that is the code it could
// break. Everything else is sent. A held file is sent the moment a later check clears it, whichever
// file's save did the clearing -- the fix is usually the OTHER file -- which Vite has no way to do
// for an update a plugin refused, so `send` replays it.
//
// What this cannot see: an import erased because it was type-only leaves no edge in Vite's module
// graph, so a file used only for its types is released past an error it caused. Its code does not
// run anyway; the error waits for the next save that touches it.

import type { ViteDevServer } from "vite";

/** An error an edit introduced, already said the way the panel's one-line row can show it. */
export interface FreshError {
  file: string;
  reason: string;
}

/** A typecheck's answer: what is new since the page's tree last checked clean, or why it could not ask. */
export type TypeCheckReport =
  | { failed: string }
  | {
      fresh: FreshError[];
      /** The tree just checked is now the page's: its errors stop being new. */
      accept(): void;
    };

/**
 * Which waiting files a check holds, and why.
 *
 * `dependents` is every file that imports the one asked about, directly or further up.
 */
export function decideTypeHolds(
  waiting: readonly string[],
  fresh: readonly FreshError[],
  dependents: (file: string) => ReadonlySet<string>,
): { held: Map<string, string>; released: string[] } {
  const held = new Map<string, string>();
  for (const file of waiting) {
    const reach = dependents(file);
    const error = fresh.find((each) => each.file === file || reach.has(each.file));
    if (error) held.set(file, error.reason);
  }
  return { held, released: waiting.filter((file) => !held.has(file)) };
}

/** How long a burst of saves gets to finish before one check judges all of it. */
const SETTLE_MS = 150;

export interface TypeHoldsIO {
  check(): Promise<TypeCheckReport>;
  dependents(file: string): ReadonlySet<string>;
  /** Send these files' updates, which were refused when they were saved. */
  send(files: string[]): void;
  /** What is held now, by file, so the panel's row can say so. */
  publish(held: Map<string, string>): void;
  log(message: string): void;
}

export function createTypeHolds(io: TypeHoldsIO, settleMs = SETTLE_MS) {
  /** Whole files whose update has not been sent, held or about to be judged. */
  const waiting = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let checking = false;
  let again = false;
  let failing = false;

  async function judge(): Promise<void> {
    if (waiting.size === 0) return;
    const report = await io.check();
    if ("failed" in report) {
      // Nothing can be judged, so nothing is held: a dev loop that froze because the checker went
      // missing would be worse than the errors it was there to stop. Said once, not every save.
      if (!failing) io.log(`${report.failed}; sending updates on the parse check alone`);
      failing = true;
      io.send([...waiting]);
      waiting.clear();
      io.publish(new Map());
      return;
    }
    failing = false;
    const { held, released } = decideTypeHolds([...waiting], report.fresh, io.dependents);
    for (const file of released) waiting.delete(file);
    if (released.length > 0) io.send(released);
    io.publish(held);
    if (held.size === 0) report.accept();
  }

  async function run(): Promise<void> {
    if (checking) {
      again = true;
      return;
    }
    checking = true;
    try {
      do {
        again = false;
        await judge();
      } while (again);
    } catch (error) {
      io.log(`could not judge an update: ${String(error)}`);
    } finally {
      checking = false;
    }
  }

  return {
    /** A whole file was saved and its update refused: judge it with whatever else is waiting. */
    wait(file: string): void {
      waiting.add(file);
      clearTimeout(timer);
      timer = setTimeout(() => void run(), settleMs);
    },
    /**
     * Check the tree once as the server starts, so the errors it already has are the baseline. The
     * first answer is accepted as it stands; waiting for the first save would accept that save's.
     */
    prime(): void {
      void io.check().catch(() => {});
    },
    /** The page was reloaded onto the tree as it is, so nothing is waiting any more. */
    clear(): void {
      waiting.clear();
      io.publish(new Map());
    },
  };
}

/**
 * Every file that imports this one, directly or further up: the code an error in it could break.
 *
 * Not through stylesheets. Tailwind registers every source with the stylesheet, so walking through
 * it would make every file a dependent of every other.
 */
export function dependentsOf(server: ViteDevServer | undefined, file: string): Set<string> {
  const found = new Set<string>();
  const stack = [...(server?.environments.client.moduleGraph.getModulesByFile(file) ?? [])];
  while (stack.length > 0) {
    for (const importer of stack.pop()!.importers) {
      if (!importer.file || importer.file.endsWith(".css") || found.has(importer.file)) continue;
      found.add(importer.file);
      stack.push(importer);
    }
  }
  return found;
}

/**
 * Send these files' updates again. Vite keeps nothing of an update a plugin refused, so a released
 * file is sent from the module graph; `reloadModule` goes straight to the update, past the hook that
 * refused it.
 */
export function resend(server: ViteDevServer | undefined, files: string[]): void {
  const client = server?.environments.client;
  if (!client) return;
  for (const file of files) {
    for (const module of client.moduleGraph.getModulesByFile(file) ?? []) void client.reloadModule(module);
  }
}
