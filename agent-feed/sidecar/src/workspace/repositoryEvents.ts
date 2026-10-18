// Where a repository's filesystem events come from. Two ways, one per platform, because the cheap
// way on one is the expensive way on the other. Measured 2026-09-25 under Bun:
//
//   macOS, one recursive watch (FSEvents) on all of this repository      2ms,   3 descriptors
//   macOS, 355 one-directory watches (kqueue)                          282ms, 356 descriptors,
//                                                                              none freed by close()
//   Linux, one recursive watch (inotify) on `rags`, 9,104 directories  5.1s blocked, 9,104 watches
//   Linux, 300 one-directory watches (inotify)                           9ms, 1 instance, 300 watches
//
// A recursive watch under Bun on Linux walks the whole tree on the main thread, ignored build
// output included, and `fs.watch` has no way to skip any of it. So Linux watches only the
// directories git reports, one at a time, and macOS watches everything and drops what does not
// matter. What matters is decided in one place for both, in `repositoryWatch.ts`.

import { watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { type TreeWatch, watchTree } from "@/transcripts/catalog/watchTree";

export type RepositoryEventSource = "tree" | "folders";

/** The source this platform should use. See the measurements at the top of this file. */
export const PLATFORM_EVENT_SOURCE: RepositoryEventSource = process.platform === "darwin" ? "tree" : "folders";

export interface RepositoryEvents {
  /** The directories whose entries matter, replacing the previous set. */
  setFolders(folders: ReadonlySet<string>): void;
  /** One more, for a directory that appeared between two listings. */
  addFolder(folder: string): void;
  close(): Promise<void>;
}

/**
 * Reports every path that changed under `top`, as an absolute path.
 *
 * `tree` reports more than the folder set and relies on the caller to filter; `folders` reports
 * exactly the folder set. Either way the caller filters, so the two cannot disagree about what
 * counts.
 */
export function repositoryEvents(
  source: RepositoryEventSource,
  top: string,
  onPath: (path: string) => void,
  onError: (error: unknown) => void,
): RepositoryEvents {
  return source === "tree" ? treeEvents(top, onPath, onError) : folderEvents(onPath, onError);
}

function treeEvents(top: string, onPath: (path: string) => void, onError: (error: unknown) => void): RepositoryEvents {
  const tree: TreeWatch = watchTree({ root: top, depth: Number.POSITIVE_INFINITY, onPath, onError });
  return {
    setFolders: () => {},
    addFolder: () => {},
    close: () => tree.close(),
  };
}

function folderEvents(onPath: (path: string) => void, onError: (error: unknown) => void): RepositoryEvents {
  const watchers = new Map<string, FSWatcher>();

  const add = (folder: string): void => {
    if (watchers.has(folder)) return;
    try {
      const watcher = watch(folder, (_event, name) => {
        if (name) onPath(join(folder, String(name)));
      });
      // A directory that is deleted takes its watch with it; the next listing will not name it.
      watcher.on("error", () => {
        watchers.delete(folder);
        watcher.close();
      });
      watchers.set(folder, watcher);
    } catch (error) {
      // Gone between the listing and the watch, which the listing after this one will agree with.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") onError(error);
    }
  };

  return {
    setFolders(folders) {
      // Closing is safe here and only here: on Linux a closed watch releases its inotify watch and
      // the next one on that path works (measured, four rounds). On macOS neither is true, which is
      // one more reason macOS never uses this source.
      for (const [folder, watcher] of watchers) {
        if (folders.has(folder)) continue;
        watcher.close();
        watchers.delete(folder);
      }
      for (const folder of folders) add(folder);
    },
    addFolder: add,
    async close() {
      for (const watcher of watchers.values()) watcher.close();
      watchers.clear();
    },
  };
}
