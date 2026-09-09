import { watch, type FSWatcher as NodeWatcher } from "node:fs";
import { stat } from "node:fs/promises";
import { join, sep } from "node:path";

/**
 * A watch on a whole directory tree, costing a handful of descriptors instead of one per file.
 *
 * The reason this exists rather than another `chokidar.watch`: chokidar walks the tree and opens
 * its own watch on every entry it finds. Measured 2026-09-09 on `~/.claude/projects`, one watcher
 * in an otherwise empty process --
 *
 *   chokidar.watch(root, { depth: 1 })      1033 open descriptors, 950 of them .jsonl files
 *   fs.watch(root, { recursive: true })       11 open descriptors, none of them .jsonl
 *
 * -- and this sidecar watches three such corpora, which is where its ~2000 descriptors came from.
 * Those are not free: every watch in the process shares one watcher thread, and on 2026-09-09 the
 * sidecar deadlocked with its main thread parked on that thread's lock. Fewer watches is the
 * pressure removed rather than ordered around.
 *
 * `fs.watch` with `recursive` is FSEvents-backed on macOS, which is the same mechanism chokidar
 * used before it dropped fsevents in v4 (Sep 2024) and started walking trees instead.
 *
 * What is LOST relative to chokidar, and has to be rebuilt by whoever calls this: the event kind.
 * `fs.watch` reports `rename` or `change` and neither maps to add/change/unlink, so a caller that
 * needs to tell them apart asks the filesystem. See `watchTreeEntries`.
 */
export interface TreeWatch {
  close(): Promise<void>;
}

/**
 * How long identical paths are coalesced.
 *
 * `fs.watch` reports one filesystem change more than once -- a write is commonly a `rename` and a
 * `change` together -- and every caller here reacts by reading the file or reconciling a catalog.
 * A window this short is invisible against those, and it halves the work.
 */
const COALESCE_MS = 20;

/** How often a root that does not exist yet is tried again. */
const RETRY_MS = 30_000;

/**
 * Watches every path under `root`, no deeper than `depth` separators below it.
 *
 * A missing root is not an error: `chokidar` waited for one to appear and so does this, because
 * the pi sessions directory legitimately does not exist until pi has run once. The retry is
 * unreferenced, so it never holds the process open by itself.
 */
export function watchTree(options: {
  root: string;
  /** Deepest path reported, counted in separators below the root. */
  depth: number;
  onPath: (path: string) => void;
  onError: (error: unknown) => void;
}): TreeWatch {
  const { root, depth, onPath, onError } = options;
  let watcher: NodeWatcher | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  const recent = new Map<string, ReturnType<typeof setTimeout>>();

  const deliver = (relative: string): void => {
    // Reported without a name on some platforms, and there is nothing to resolve it to.
    if (!relative) return;
    if (relative.split(sep).length - 1 > depth) return;
    const path = join(root, relative);
    const pending = recent.get(path);
    if (pending) clearTimeout(pending);
    const timer = setTimeout(() => {
      recent.delete(path);
      try {
        onPath(path);
      } catch (error) {
        onError(error);
      }
    }, COALESCE_MS);
    timer.unref?.();
    recent.set(path, timer);
  };

  const attach = (): void => {
    if (closed) return;
    try {
      const opened = watch(root, { recursive: true }, (_event, relative) => {
        deliver(typeof relative === "string" ? relative : "");
      });
      opened.on("error", (error) => onError(error));
      watcher = opened;
    } catch (error) {
      // A root that is not there yet is the expected case; anything else is worth saying.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") onError(error);
      retry = setTimeout(attach, RETRY_MS);
      retry.unref?.();
    }
  };

  attach();

  return {
    async close(): Promise<void> {
      closed = true;
      if (retry) {
        clearTimeout(retry);
        retry = null;
      }
      for (const timer of recent.values()) clearTimeout(timer);
      recent.clear();
      watcher?.close();
      watcher = null;
    },
  };
}

/** What happened to a path, worked out from the filesystem rather than from the event. */
export type EntryChange = "appeared" | "written" | "vanished";

/**
 * The same watch, with add/change/unlink rebuilt.
 *
 * `fs.watch` cannot tell them apart, so this asks: gone from disk is `vanished`, present and not
 * seen before is `appeared`, present and seen before is `written`. The set of seen paths holds
 * strings rather than descriptors, which is the whole point -- a thousand paths is a few tens of
 * kilobytes against the thousand file handles chokidar spent to answer the same question.
 *
 * It starts empty, so the first event for a file that already existed reads as `appeared`. That is
 * harmless where it matters: an idle file emits no events at all, so this only ever happens once
 * per file that is actually being written, and the callers treat appearing as a reconcile they
 * already run on a debounce.
 */
export function watchTreeEntries(options: {
  root: string;
  depth: number;
  /** Paths this returns false for are ignored entirely, before any stat. */
  accepts?: (path: string) => boolean;
  onEntry: (path: string, change: EntryChange) => void;
  onError: (error: unknown) => void;
}): TreeWatch {
  const seen = new Set<string>();
  return watchTree({
    root: options.root,
    depth: options.depth,
    onError: options.onError,
    onPath: (path) => {
      if (options.accepts && !options.accepts(path)) return;
      void stat(path).then(
        () => {
          const change: EntryChange = seen.has(path) ? "written" : "appeared";
          seen.add(path);
          options.onEntry(path, change);
        },
        () => {
          seen.delete(path);
          options.onEntry(path, "vanished");
        },
      );
    },
  });
}
