// One place that holds the roster, the shared state and the git status, and tells every open
// stream when any of them moves. The git status itself is watched by `RepositoryGitWatch`, which a
// Bot's header reads too; this relays it.
//
// The Swift equivalent was spread across `WorkspaceIDEController` (which held it), the lane session
// (which pushed it) and `WorkspaceObservationCoordinator` (which watched the disk). It is one
// object here because the three change together: a file lands, so git moves, so the tree's
// decorations move, so every reader of that workspace needs a new projection.

import { dirname, join, relative } from "node:path";
import type { WorkspaceGitStatus, WorkspaceStreamEvent, WorkspaceSummary } from "@agentdesk/agent-feed-wire";
import { PLATFORM_EVENT_SOURCE, type RepositoryEvents, repositoryEvents } from "@/workspace/repositoryEvents";
import type { RepositoryGitWatch } from "@/workspace/repositoryWatch";
import { type DirectoryGitStatus, gitStatus } from "@/workspace/workspaceGit";
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

/*
 * What a workspace reports is the entries of the directories its tree draws -- the root and the
 * ones a reader has expanded -- and nothing deeper. `buildTree` descends only into expanded
 * directories, so a change inside a collapsed one has nowhere to be drawn. Watching what is drawn
 * and drawing what is watched is one rule, not two.
 *
 * Never by walking the tree. Measured 2026-09-10 on this repository, 31k files under a root
 * chokidar was asked to watch recursively: **54.4 seconds to `ready`, during which a 10ms interval
 * fired twice where 5,440 firings were due**, so the sidecar failed its readiness probe and was
 * respawned into the same 54 seconds. The events come from `repositoryEvents`, which walks nothing
 * on either platform: one FSEvents watch per root on macOS, whose extra paths are dropped here, and
 * one watch per drawn directory on Linux.
 *
 * And never chokidar, which held a watch per FILE in each directory and closed it when the file
 * went -- and a Bun watch `close()` can wedge the process for good (`BotStore`'s `watcher`). An
 * editor's save is a temporary file made and removed, so that was a close on every save.
 */

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
   * One event source per workspace root, opened once and never closed, not even by `close`.
   *
   * Never closed because a Bun watch `close()` can park the main thread for good, and because Bun's
   * `fs.watch` makes every second watch on a path inert (AGENTS.md, "under Bun, a watch you close
   * poisons the NEXT watch"). A directory is added once and never removed: watched paths cost no
   * measurable memory, so that is the cheap half of the trade.
   */
  private readonly rootEvents = new Map<string, RepositoryEvents>();
  /** The directories whose entries are reported. See the note above `CHANGE_DEBOUNCE_MS`. */
  private readonly watchedPaths = new Set<string>();
  /** Set by `close`, which cannot close the watches, so their events stop here instead. */
  private closed = false;
  /**
   * Each workspace's subscription to its repository's status, held only while a stream is open.
   *
   * The status comes from the repository watch rather than from the listings above, because those
   * are one directory deep and git is not: an edit inside a collapsed directory moves the status
   * and reaches no listing. Held only while someone reads, because a subscription is what makes
   * the repository watch run git.
   */
  private readonly gitFollows = new Map<string, { root: string; stop: () => void }>();

  constructor(
    readonly store: WorkspaceStore,
    readonly sharedState: WorkspaceSharedStateStore,
    private readonly repositories: RepositoryGitWatch,
  ) {
    this.store.subscribe((workspaces) => {
      this.emit({ type: "workspaces", workspaces });
      for (const workspace of workspaces) this.watch(workspace);
      this.followGit();
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
      this.watchExpanded(workspace.id, this.sharedState.snapshot(workspace.id).expandedDirectoryPaths);
    }
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
    this.followGit();
    return () => {
      this.listeners.delete(listener);
      this.followGit();
    };
  }

  /** Follows every workspace's repository while anyone is reading, and none while nobody is. */
  private followGit(): void {
    const wanted = this.listeners.size > 0 ? this.store.list() : [];
    const keep = new Set(wanted.map((workspace) => workspace.id));
    for (const [id, follow] of this.gitFollows) {
      const workspace = this.store.get(id);
      if (keep.has(id) && workspace?.root === follow.root) continue;
      follow.stop();
      this.gitFollows.delete(id);
    }
    for (const workspace of wanted) {
      if (this.gitFollows.has(workspace.id)) continue;
      const { id, root } = workspace;
      const stop = this.repositories.subscribe(root, (status) => void this.gitMoved(id, status));
      this.gitFollows.set(id, { root, stop });
    }
  }

  private async gitMoved(id: string, status: DirectoryGitStatus | null): Promise<void> {
    const moved: WorkspaceGitStatus = {
      workspaceId: id,
      branch: status?.branch ?? null,
      entries: status?.entries ?? [],
    };
    this.gitCache.set(id, moved);
    this.emit({ type: "git", status: moved });
    await this.emitTree(id);
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
    this.watchPath(workspace.root, workspace.root);
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
      this.watchPath(workspace.root, join(workspace.root, path));
    }
  }

  /** Report the entries of one more directory under `root`, once. See the note above `CHANGE_DEBOUNCE_MS`. */
  private watchPath(root: string, absolutePath: string): void {
    if (this.watchedPaths.has(absolutePath)) return;
    if (UNWATCHED.test(absolutePath)) return;
    this.watchedPaths.add(absolutePath);
    let events = this.rootEvents.get(root);
    if (!events) {
      events = repositoryEvents(
        PLATFORM_EVENT_SOURCE,
        root,
        (path) => this.heard(path),
        (error) => console.error("workspace watch failed", error),
      );
      this.rootEvents.set(root, events);
    }
    events.addFolder(absolutePath);
  }

  /** A path changed on disk. Kept only if it is an entry of a directory the tree draws. */
  private heard(path: string): void {
    if (this.closed || UNWATCHED.test(path) || !this.watchedPaths.has(dirname(path))) return;
    this.recordChange(path);
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
    // The git status is not re-read here: the repository watch answers for that, from every
    // directory git cares about rather than only the ones this listing watches.
    await this.emitTree(id);
  }

  /**
   * Stops reporting. For tests and shutdown, not for a departing reader. The watches stay open and
   * their events are dropped, for the reason on `rootEvents`.
   */
  async close(): Promise<void> {
    this.closed = true;
    for (const timer of this.changeTimers.values()) clearTimeout(timer);
    this.changeTimers.clear();
    for (const follow of this.gitFollows.values()) follow.stop();
    this.gitFollows.clear();
    this.watchedPaths.clear();
  }
}
