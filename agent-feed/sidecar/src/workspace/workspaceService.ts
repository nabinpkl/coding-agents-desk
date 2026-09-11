// One place that holds the roster, the shared state and the git status, and tells every open
// stream when any of them moves.
//
// The Swift equivalent was spread across `WorkspaceIDEController` (which held it), the lane session
// (which pushed it) and `WorkspaceObservationCoordinator` (which watched the disk). It is one
// object here because the three change together: a file lands, so git moves, so the tree's
// decorations move, so every reader of that workspace needs a new projection.

import chokidar, { type FSWatcher } from "chokidar";
import { join, relative } from "node:path";
import type {
  WorkspaceGitStatus,
  WorkspaceStreamEvent,
  WorkspaceSummary,
} from "@agentdesk/agent-feed-wire";
import { gitStatus } from "@/workspace/workspaceGit";
import { isStorablePath } from "@/workspace/workspacePaths";
import { WorkspaceSharedStateStore } from "@/workspace/workspaceSharedState";
import { WorkspaceStore } from "@/workspace/workspaceStore";
import { buildTree } from "@/workspace/workspaceTree";

/**
 * Directories a watch never looks inside.
 *
 * Not a taste call: each of these is written by a build rather than by a reader, and a single
 * `npm install` inside a watched `node_modules` produces tens of thousands of events that say
 * nothing about the tree anyone is looking at.
 *
 * This is now a second line of defence rather than the first one. Since every watch is one
 * directory deep, a build directory costs one listing if a reader expands it and nothing at all
 * otherwise; the list matters for the events it suppresses, not for a walk it prevents.
 */
const UNWATCHED = /(^|[\/\\])(\.git|node_modules|\.build|\.next|dist|target|\.venv)([\/\\]|$)/;

/**
 * Every watch is exactly one directory deep, and this is the reason.
 *
 * Measured 2026-09-10 on this repository, 31k files under a root chokidar was asked to watch
 * recursively: **54.4 seconds to `ready`, during which a 10ms interval fired twice where 5,440
 * firings were due.** The initial walk does not merely take a long time under Bun, it starves the
 * event loop for its whole duration -- so the sidecar answers nothing, the host's readiness probe
 * fails, and the host kills and respawns it into the same 54 seconds. One workspace in the roster
 * was enough to make the whole sidecar unusable.
 *
 * The same root watched with `depth: 0` reaches `ready` in **12ms**, and adding 203 expanded
 * directories to it afterwards costs **2ms**. So the depth is not a tuning knob, it is what keeps
 * the process alive.
 *
 * It costs nothing in coverage, because the tree is lazy in exactly the same shape: `buildTree`
 * descends only into directories the reader has expanded, so a change inside a collapsed directory
 * has nowhere to be drawn. Watching what is drawn and drawing what is watched is one rule, not two.
 */
const WATCH_DEPTH = 0;

/**
 * How long a burst of filesystem events is collected before it becomes one `changed`.
 *
 * A save from an editor is several events -- a temporary file, a rename, an attribute change -- and
 * a git operation is thousands. Coalescing is what keeps one `git checkout` from being one
 * projection per file.
 */
const CHANGE_DEBOUNCE_MS = 120;

export class WorkspaceService {
  private readonly listeners = new Set<(event: WorkspaceStreamEvent) => void>();
  private readonly gitCache = new Map<string, WorkspaceGitStatus>();
  private readonly pendingChanges = new Map<string, Set<string>>();
  private readonly changeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /**
   * One watcher for the process, and a path is added to it once and never removed.
   *
   * Bun's `fs.watch` makes every second watch on a path inert, so a watcher closed when its last
   * reader leaves comes back dead for the next one (AGENTS.md, "under Bun, a watch you close
   * poisons the NEXT watch"). Watched paths cost no measurable memory, so never removing one is
   * the cheap half of that trade.
   */
  private watcher: FSWatcher | null = null;
  private readonly watchedPaths = new Set<string>();
  /**
   * Resolves when the watcher has finished its first pass and is reporting changes.
   *
   * `ignoreInitial` suppresses events for what was already there, so a file written between the
   * watch starting and it becoming ready is reported by neither -- it is not new enough to be an
   * event and not old enough to have been in the first pass. In production that window is the
   * moment a workspace is added, before anyone is looking at it. In a test it is the difference
   * between an assertion and a coin toss, which is what this exists for.
   */
  private watching: Promise<void> = Promise.resolve();

  constructor(
    readonly store: WorkspaceStore,
    readonly sharedState: WorkspaceSharedStateStore,
  ) {
    this.store.subscribe((workspaces) => {
      this.emit({ type: "workspaces", workspaces });
      for (const workspace of workspaces) this.watch(workspace);
    });
    this.sharedState.subscribe((state) => {
      this.emit({ type: "sharedState", state });
      this.watchExpanded(state.workspaceId, state.expandedDirectoryPaths);
      void this.emitTree(state.workspaceId);
    });
  }

  async ready(): Promise<void> {
    await Promise.all([this.store.ready, this.sharedState.ready]);
    for (const workspace of this.store.list()) {
      this.watch(workspace);
      this.watchExpanded(
        workspace.id,
        this.sharedState.snapshot(workspace.id).expandedDirectoryPaths,
      );
    }
  }

  /** Resolves once changes are being reported. See `watching`. */
  async whenWatching(): Promise<void> {
    await this.watching;
  }

  /**
   * Every directory being watched, which is the invariant worth asserting: it must be the root
   * plus the directories a reader has expanded, and nothing underneath them.
   *
   * Exposed because the alternative -- writing a file and waiting for the event -- measures the
   * operating system's delivery schedule rather than this class, and does it slowly enough to fail
   * under a loaded test suite while the code is correct.
   */
  get watchedDirectories(): readonly string[] {
    return [...this.watchedPaths];
  }

  subscribe(listener: (event: WorkspaceStreamEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(event: WorkspaceStreamEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  /** The workspace, or undefined. Callers turn that into the `workspaceUnavailable` refusal. */
  workspace(id: string): WorkspaceSummary | undefined {
    return this.store.get(id);
  }

  /**
   * The git status, recomputed rather than served from the cache.
   *
   * The cache exists so a tree projection does not shell out to git for every expansion, not so a
   * reader who asks for the status gets a stale one.
   */
  async refreshGit(id: string): Promise<WorkspaceGitStatus> {
    const workspace = this.store.get(id);
    if (!workspace) return { workspaceId: id, branch: null, entries: [] };
    const status = await gitStatus(id, workspace.root);
    this.gitCache.set(id, status);
    return status;
  }

  private cachedGit(id: string): WorkspaceGitStatus {
    return this.gitCache.get(id) ?? { workspaceId: id, branch: null, entries: [] };
  }

  async tree(id: string) {
    const workspace = this.store.get(id);
    if (!workspace) return [];
    if (!this.gitCache.has(id)) await this.refreshGit(id);
    const state = this.sharedState.snapshot(id);
    return buildTree(workspace.root, state.expandedDirectoryPaths, this.cachedGit(id).entries);
  }

  private async emitTree(id: string): Promise<void> {
    this.emit({ type: "tree", workspaceId: id, tree: await this.tree(id) });
  }

  private watch(workspace: WorkspaceSummary): void {
    this.watchPath(workspace.root);
  }

  /**
   * Watch each directory the reader has open, so the listings the tree draws are the listings that
   * report changes.
   *
   * An expanded path arrives from an unauthenticated client, so it is checked with the same
   * predicate the store uses before it becomes a path on this machine -- `isStorablePath` refuses
   * anything absolute, empty, `..`-bearing, NUL-bearing or oversized. A path that fails is skipped
   * rather than throwing: it is already absent from the tree the same state produced, so refusing
   * to watch it agrees with what the reader can see.
   */
  private watchExpanded(workspaceId: string, expandedPaths: readonly string[]): void {
    const workspace = this.store.get(workspaceId);
    if (!workspace) return;
    for (const path of expandedPaths) {
      if (!isStorablePath(path)) continue;
      this.watchPath(join(workspace.root, path));
    }
  }

  /** Add one shallow watch, once. See `WATCH_DEPTH` for why a watch is never deep. */
  private watchPath(absolutePath: string): void {
    if (this.watchedPaths.has(absolutePath)) return;
    if (UNWATCHED.test(absolutePath)) return;
    this.watchedPaths.add(absolutePath);
    if (!this.watcher) {
      // Created with the first real path rather than with `[]`: a chokidar watcher created empty
      // never reaches `ready`, so one filled by `add` afterwards would hang instead of watching.
      this.watcher = chokidar.watch(absolutePath, {
        ignored: UNWATCHED,
        ignoreInitial: true,
        followSymlinks: false,
        depth: WATCH_DEPTH,
      });
      const watcher = this.watcher;
      this.watching = new Promise<void>((resolve) => watcher.once("ready", () => resolve()));
      watcher.on("all", (_event, path) => this.recordChange(path));
      watcher.on("error", (error) => {
        console.error("workspace watch failed", error);
      });
      return;
    }
    this.watcher.add(absolutePath);
  }

  /**
   * Attribute a changed absolute path to the workspaces that contain it, and coalesce.
   *
   * A path can belong to more than one workspace when one root is inside another, which is a
   * perfectly ordinary way to register a monorepo package beside its repository.
   */
  private recordChange(absolutePath: string): void {
    for (const workspace of this.store.list()) {
      const relativePath = relative(workspace.root, absolutePath);
      if (relativePath === "" || relativePath.startsWith("..")) continue;
      const pending = this.pendingChanges.get(workspace.id) ?? new Set<string>();
      pending.add(relativePath);
      this.pendingChanges.set(workspace.id, pending);
      if (this.changeTimers.has(workspace.id)) continue;
      this.changeTimers.set(
        workspace.id,
        setTimeout(() => void this.flushChanges(workspace.id), CHANGE_DEBOUNCE_MS),
      );
    }
  }

  private async flushChanges(id: string): Promise<void> {
    this.changeTimers.delete(id);
    const changedPaths = [...(this.pendingChanges.get(id) ?? [])];
    this.pendingChanges.delete(id);
    if (changedPaths.length === 0) return;
    this.emit({ type: "changed", workspaceId: id, changedPaths });
    this.emit({ type: "git", status: await this.refreshGit(id) });
    await this.emitTree(id);
  }

  /** Stops the process-wide watcher. For tests and shutdown, not for a departing reader. */
  async close(): Promise<void> {
    for (const timer of this.changeTimers.values()) clearTimeout(timer);
    this.changeTimers.clear();
    await this.watcher?.close();
    this.watcher = null;
    this.watchedPaths.clear();
  }
}
