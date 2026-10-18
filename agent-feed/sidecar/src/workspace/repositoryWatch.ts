// What git says about a directory, pushed whenever it may have changed, for every reader of it.
//
// One watch per repository, however many readers: an IDE workspace and a Bot bound to the same
// checkout, or to two directories inside it, share it, because `git status` answers for the whole
// repository either way.
//
// Shaped after VS Code's git extension (`extensions/git/src/repository.ts`): a change anywhere in
// the working tree or in the first level of the git directory -- `index.lock` excepted -- asks for
// a status, the ask waits for a quiet moment, and only one status runs at a time. Where it differs:
//
// - What "anywhere" means is what git reports, not what is on disk. `listGitPaths` names the
//   files git tracks or would add and the directories holding them, and a change to anything
//   else cannot change the status. On Linux that set is also what is watched (see `repositoryEvents.ts`); on macOS it is
//   the filter over a watch of everything.
// - Git runs only while someone is subscribed, where VS Code waits for its window to have focus.
//   The panel drops its subscription while its page is hidden, which is the same thing.
//
// Watches are kept for the life of the process rather than closed with their last reader. Under Bun
// on macOS a closed watch keeps its descriptor and poisons the next watch on its path (AGENTS.md),
// and a repository nobody reads costs one idle watch, no git at all.

import { existsSync, type Stats } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import {
  PLATFORM_EVENT_SOURCE,
  repositoryEvents,
  type RepositoryEventSource,
  type RepositoryEvents,
} from "@/workspace/repositoryEvents";
import {
  type DirectoryGitStatus,
  type GitPaths,
  isGitIgnored,
  listGitPaths,
  readGitStatus,
  repositoryLocation,
} from "@/workspace/workspaceGit";

/** A status, or null for a directory that is not in a repository. */
export type GitStatusListener = (status: DirectoryGitStatus | null) => void;

/**
 * How long a burst of changes is collected before git is asked, and the longest a burst can put it
 * off. VS Code waits a second; an agent writing a file every half second would otherwise defer the
 * status forever, which is what the ceiling is for.
 */
const QUIET_MS = 1_000;
const LONGEST_WAIT_MS = 3_000;

interface Repository {
  top: string;
  gitDir: string;
  events: RepositoryEvents;
  /** Files whose changes matter. See `listGitPaths`. */
  files: Set<string>;
  /** Directories whose entries matter, and the git directory. */
  folders: Set<string>;
  /** Directories made since a listing and not in one yet, because git lists no empty directory. */
  adopted: Set<string>;
  /** Paths git ignores, found between two listings. Everything beneath an ignored one is too. */
  ignored: Set<string>;
  pendingIgnoreChecks: Map<string, Promise<boolean>>;
  listeners: Set<GitStatusListener>;
  /** The last status read, or undefined before the first. */
  status: DirectoryGitStatus | null | undefined;
  /** A change arrived while nobody was subscribed, so `status` may be old. */
  stale: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  waitingSince: number | null;
  reading: boolean;
  readAgain: boolean;
}

interface Subscription {
  directory: string;
  listener: GitStatusListener;
  active: boolean;
  repository: Repository | null;
}

export interface RepositoryGitWatchOptions {
  source?: RepositoryEventSource;
  quietMs?: number;
  longestWaitMs?: number;
}

export class RepositoryGitWatch {
  private readonly repositories = new Map<string, Promise<Repository>>();
  private readonly source: RepositoryEventSource;
  private readonly quietMs: number;
  private readonly longestWaitMs: number;
  /** Directories outside any repository, watched one level deep for a `.git` to appear. */
  private readonly plainDirectories = new Map<string, Set<Subscription>>();
  private readonly plainWatches: RepositoryEvents[] = [];

  constructor(options: RepositoryGitWatchOptions = {}) {
    this.source = options.source ?? PLATFORM_EVENT_SOURCE;
    this.quietMs = options.quietMs ?? QUIET_MS;
    this.longestWaitMs = options.longestWaitMs ?? LONGEST_WAIT_MS;
  }

  /**
   * Follows the status of the repository `directory` is in: the current one as soon as it is
   * known, and a new one after every change that could move it. Returns unsubscribe.
   */
  subscribe(directory: string, listener: GitStatusListener): () => void {
    const subscription: Subscription = { directory, listener, active: true, repository: null };
    void this.attach(subscription).catch((error: unknown) =>
      console.error("repository watch failed to start", directory, error),
    );
    return () => {
      subscription.active = false;
      subscription.repository?.listeners.delete(listener);
      this.plainDirectories.get(directory)?.delete(subscription);
    };
  }

  private async attach(subscription: Subscription): Promise<void> {
    const { directory, listener } = subscription;
    const location = await repositoryLocation(directory);
    if (!subscription.active) return;
    if (!location) {
      this.watchPlainDirectory(subscription);
      listener(null);
      return;
    }
    const repository = await this.repository(location.top, location.gitDir);
    if (!subscription.active) return;
    subscription.repository = repository;
    repository.listeners.add(listener);
    if (repository.reading) {
      // The listener is already in the set that read answers. Only a change nobody was
      // subscribed to when it happened still needs a read after it.
      if (repository.stale) repository.readAgain = true;
      repository.stale = false;
    } else if (repository.status === undefined || repository.stale) {
      repository.stale = false;
      void this.read(repository);
    } else {
      listener(repository.status);
    }
  }

  private repository(top: string, gitDir: string): Promise<Repository> {
    const existing = this.repositories.get(top);
    if (existing) return existing;
    const created = this.createRepository(top, gitDir);
    this.repositories.set(top, created);
    return created;
  }

  private async createRepository(top: string, gitDir: string): Promise<Repository> {
    const repository: Repository = {
      top,
      gitDir,
      events: undefined as unknown as RepositoryEvents,
      files: new Set(),
      folders: new Set([top]),
      adopted: new Set(),
      ignored: new Set(),
      pendingIgnoreChecks: new Map(),
      listeners: new Set(),
      status: undefined,
      stale: false,
      timer: null,
      waitingSince: null,
      reading: false,
      readAgain: false,
    };
    const onPath = (path: string): void => void this.consider(repository, path);
    const onError = (error: unknown): void => console.error("repository watch failed", top, error);
    repository.events = repositoryEvents(this.source, top, onPath, onError);
    // A linked worktree keeps its git directory outside its working tree, where a watch of the
    // tree does not reach, so it gets a shallow watch of its own.
    if (this.source === "tree" && !isInside(top, gitDir)) {
      const gitWatch = repositoryEvents("folders", gitDir, onPath, onError);
      gitWatch.setFolders(new Set([gitDir]));
      this.plainWatches.push(gitWatch);
    }
    this.adoptListing(repository, await listGitPaths(top));
    return repository;
  }

  /** Takes a fresh listing as what matters, the git directory included, and watches it. */
  private adoptListing(repository: Repository, paths: GitPaths): void {
    paths.folders.add(repository.gitDir);
    // An adopted directory stays watched until git lists it or it is gone, or the file an agent
    // writes into it a moment after this listing would land in a directory nobody watches.
    for (const folder of repository.adopted) {
      if (paths.folders.has(folder) || !existsSync(folder)) repository.adopted.delete(folder);
      else paths.folders.add(folder);
    }
    repository.files = paths.files;
    repository.folders = paths.folders;
    // A `.gitignore` edit is one of the changes that brings a new listing, so what was ignored is
    // asked again rather than remembered across it.
    repository.ignored.clear();
    repository.events.setFolders(paths.folders);
  }

  /**
   * Decides whether a changed path can move the status, and asks for one if it can.
   *
   * In the git directory, only its first level counts, which is where the index, `HEAD` and the
   * merge and rebase markers live; `objects/` and `logs/` churn on every commit and say nothing a
   * first-level file does not. In the working tree, a path counts when its directory is one git
   * lists, or is a directory git would list once it held a file.
   */
  private async consider(repository: Repository, path: string): Promise<void> {
    if (isInside(repository.gitDir, path)) {
      const inGit = relative(repository.gitDir, path);
      if (inGit.includes(sep) || inGit === "index.lock" || inGit.startsWith(".watchman-cookie")) return;
      this.schedule(repository);
      return;
    }
    if (!isInside(repository.top, path) || path === repository.top) return;
    if (repository.files.has(path) || repository.folders.has(path)) {
      this.schedule(repository);
      return;
    }
    // Neither listed: a new file or directory, or something git ignores -- a build's output, an
    // editor's swap file. Only the first two can move the status.
    if (await this.inIgnoredDirectory(repository, path)) return;
    if (await this.ignoredPath(repository, path)) return;
    this.schedule(repository);
    // A directory is not in the listing until it holds a file, and a file written into it before
    // the next listing would go unseen, so it is adopted now.
    await this.adoptIfDirectory(repository, path);
  }

  /** Whether any directory between `top` and `path` is one git ignores, asking git at most once. */
  private async inIgnoredDirectory(repository: Repository, path: string): Promise<boolean> {
    const steps = relative(repository.top, dirname(path)).split(sep);
    let directory = repository.top;
    for (const step of steps) {
      directory = join(directory, step);
      if (repository.ignored.has(directory)) return true;
      if (repository.folders.has(directory)) continue;
      return this.ignoredPath(repository, directory);
    }
    return false;
  }

  /** Whether git ignores a path outside the listing, asking once per path per listing. */
  private ignoredPath(repository: Repository, path: string): Promise<boolean> {
    if (repository.ignored.has(path)) return Promise.resolve(true);
    const pending = repository.pendingIgnoreChecks.get(path);
    if (pending) return pending;
    const check = isGitIgnored(repository.top, path).then((ignored) => {
      repository.pendingIgnoreChecks.delete(path);
      if (ignored) repository.ignored.add(path);
      return ignored;
    });
    repository.pendingIgnoreChecks.set(path, check);
    return check;
  }

  /** Watches a new directory and every unignored one beneath it, which `mkdir -p` makes at once. */
  private async adoptIfDirectory(repository: Repository, path: string): Promise<void> {
    let info: Stats;
    try {
      info = await stat(path);
    } catch {
      return;
    }
    if (!info.isDirectory() || repository.folders.has(path)) return;
    if (basename(path) === ".git" || (await this.ignoredPath(repository, path))) return;
    repository.folders.add(path);
    repository.adopted.add(path);
    repository.events.addFolder(path);
    let children: string[] = [];
    try {
      children = (await readdir(path, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(path, entry.name));
    } catch {
      return;
    }
    await Promise.all(children.map((child) => this.adoptIfDirectory(repository, child)));
  }

  private schedule(repository: Repository): void {
    if (repository.listeners.size === 0) {
      repository.stale = true;
      return;
    }
    const now = Date.now();
    repository.waitingSince ??= now;
    if (repository.timer) clearTimeout(repository.timer);
    const wait = Math.min(this.quietMs, repository.waitingSince + this.longestWaitMs - now);
    repository.timer = setTimeout(() => void this.read(repository), Math.max(0, wait));
  }

  /** Reads the status and the folder list together, one read at a time, and tells every reader. */
  private async read(repository: Repository): Promise<void> {
    if (repository.timer) clearTimeout(repository.timer);
    repository.timer = null;
    repository.waitingSince = null;
    if (repository.reading) {
      repository.readAgain = true;
      return;
    }
    repository.reading = true;
    try {
      const [status, paths] = await Promise.all([readGitStatus(repository.top), listGitPaths(repository.top)]);
      repository.status = status;
      this.adoptListing(repository, paths);
      for (const listener of repository.listeners) {
        try {
          listener(status);
        } catch (error) {
          console.error("repository status listener failed", repository.top, error);
        }
      }
    } catch (error) {
      console.error("repository status read failed", repository.top, error);
    } finally {
      repository.reading = false;
      if (repository.readAgain) {
        repository.readAgain = false;
        this.schedule(repository);
      }
    }
  }

  /** A directory with no repository answers null, and again with a status once `.git` appears. */
  private watchPlainDirectory(subscription: Subscription): void {
    const { directory } = subscription;
    let waiting = this.plainDirectories.get(directory);
    if (!waiting) {
      waiting = new Set();
      this.plainDirectories.set(directory, waiting);
      // `git init` makes `.git` before it writes `HEAD`, and this watch sees `.git` appear once. A
      // probe that lands in between finds no repository and would never be asked again, so every
      // later event in the directory probes too while a `.git` is there -- one at a time, since a
      // burst of writes is one question.
      let probing = false;
      let probeAgain = false;
      const probe = async (): Promise<void> => {
        if (probing) {
          probeAgain = true;
          return;
        }
        probing = true;
        try {
          do {
            probeAgain = false;
            if (!(await repositoryLocation(directory))) continue;
            const subscriptions = [...(this.plainDirectories.get(directory) ?? [])];
            this.plainDirectories.get(directory)?.clear();
            for (const each of subscriptions) {
              void this.attach(each).catch((error: unknown) =>
                console.error("repository watch failed to start", directory, error),
              );
            }
            return;
          } while (probeAgain);
        } finally {
          probing = false;
        }
      };
      const onPath = (path: string): void => {
        if (this.plainDirectories.get(directory)?.size === 0) return;
        if (basename(path) !== ".git" && !existsSync(join(directory, ".git"))) return;
        void probe().catch((error: unknown) => console.error("repository probe failed", directory, error));
      };
      const watch = repositoryEvents("folders", directory, onPath, (error) =>
        console.error("directory watch failed", directory, error),
      );
      watch.setFolders(new Set([directory]));
      this.plainWatches.push(watch);
    }
    waiting.add(subscription);
  }

  /** Stops every watch. For tests and shutdown, not for a departing reader. */
  async close(): Promise<void> {
    const repositories = await Promise.all(this.repositories.values());
    this.repositories.clear();
    for (const repository of repositories) {
      if (repository.timer) clearTimeout(repository.timer);
      repository.listeners.clear();
      await repository.events.close();
    }
    await Promise.all(this.plainWatches.splice(0).map((watch) => watch.close()));
    this.plainDirectories.clear();
  }
}

function isInside(parent: string, path: string): boolean {
  return path === parent || path.startsWith(parent + sep);
}
