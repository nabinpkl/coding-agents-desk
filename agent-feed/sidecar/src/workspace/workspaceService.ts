// One place that holds the roster, the shared state and the git status, and tells every open
// stream when any of them moves.
//
// The Swift equivalent was spread across `WorkspaceIDEController` (which held it), the lane session
// (which pushed it) and `WorkspaceObservationCoordinator` (which watched the disk). It is one
// object here because the three change together: a file lands, so git moves, so the tree's
// decorations move, so every reader of that workspace needs a new projection.

import chokidar, { type FSWatcher } from "chokidar";
import { relative } from "node:path";
import type {
  WorkspaceGitStatus,
  WorkspaceStreamEvent,
  WorkspaceSummary,
} from "@agentdesk/agent-feed-wire";
import { gitStatus } from "@/workspace/workspaceGit";
import { WorkspaceSharedStateStore } from "@/workspace/workspaceSharedState";
import { WorkspaceStore } from "@/workspace/workspaceStore";
import { buildTree } from "@/workspace/workspaceTree";

/**
 * Directories a project watch never descends into.
 *
 * Not a taste call: each of these is written by a build rather than by a reader, and a single
 * `npm install` inside a watched `node_modules` produces tens of thousands of events that say
 * nothing about the tree anyone is looking at.
 */
const UNWATCHED = /(^|[\/\\])(\.git|node_modules|\.build|\.next|dist|target|\.venv)([\/\\]|$)/;

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
   * One watcher for the process, and a root is added to it once and never removed.
   *
   * Bun's `fs.watch` makes every second watch on a path inert, so a watcher closed when its last
   * reader leaves comes back dead for the next one (AGENTS.md, "under Bun, a watch you close
   * poisons the NEXT watch"). Watched paths cost no measurable memory, so never removing one is
   * the cheap half of that trade.
   */
  private watcher: FSWatcher | null = null;
  private readonly watchedRoots = new Set<string>();

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
      void this.emitTree(state.workspaceId);
    });
  }

  async ready(): Promise<void> {
    await Promise.all([this.store.ready, this.sharedState.ready]);
    for (const workspace of this.store.list()) this.watch(workspace);
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
    if (this.watchedRoots.has(workspace.root)) return;
    this.watchedRoots.add(workspace.root);
    if (!this.watcher) {
      // Created with the first real path rather than with `[]`: a chokidar watcher created empty
      // never reaches `ready`, so one filled by `add` afterwards would hang instead of watching.
      this.watcher = chokidar.watch(workspace.root, {
        ignored: UNWATCHED,
        ignoreInitial: true,
        followSymlinks: false,
      });
      this.watcher.on("all", (_event, path) => this.recordChange(path));
      this.watcher.on("error", (error) => {
        console.error("workspace watch failed", error);
      });
      return;
    }
    this.watcher.add(workspace.root);
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
    this.watchedRoots.clear();
  }
}
