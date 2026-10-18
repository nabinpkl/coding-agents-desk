// The IDE's state, and every intent that changes it.
//
// This is what `WorkspaceIDEController` was: the thing between the projections arriving from the
// sidecar and the panes drawing them. It is a hook rather than a store because the projection is
// already the single source of truth -- taking props from it, not from a second copy, is the one
// piece of ADR-0077 that survives its own supersession.

import { useCallback, useMemo, useState } from "react";
import { useLatestRef } from "@/hooks/useLatestRef";
import { usePersistentState } from "@/hooks/state/usePersistentState";
import { useStateFor } from "@/hooks/state/useStateFor";
import { useSubscription } from "@/hooks/useSubscription";
import { panelQueryClient, sourceKey, usePanelQuery } from "@/query/panelQuery";
import type {
  WorkspaceFileKind,
  WorkspaceGitStatus,
  WorkspaceOperation,
  WorkspaceSharedState,
  WorkspaceStreamEvent,
  WorkspaceSummary,
  WorkspaceTreeNode,
} from "@agentdesk/agent-feed-wire";
import type { AgentHttpTransport } from "@/features/activity-feed/transport/AgentHttpTransport";
import { WorkspaceIdeClient, WorkspaceRequestError } from "@/features/workspace-ide/workspaceIdeClient";
import { defaultFileView, hasSource } from "@/features/workspace-ide/editor/FileBody";
import { useWorkspaceIdeWriting } from "@/features/workspace-ide/useWorkspaceIdeWriting";
import {
  loadDraft,
  reconcileDraft,
  removeDraft,
} from "@/features/workspace-ide/workspaceIdeDrafts";
import {
  DEFAULT_WORKSPACE_IDE_PREFERENCES,
  loadWorkspaceIdePreferences,
  storeWorkspaceIdePreferences,
  type WorkspaceIdePreferences,
} from "@/features/workspace-ide/workspaceIdePreferences";

export type SaveState = "clean" | "dirty" | "saving" | "conflict";

export interface OpenFile {
  path: string;
  kind: WorkspaceFileKind;
  /** The text on screen, which is the draft while it is dirty. */
  text: string;
  /** The revision this draft was based on, and what a write states. */
  revision: string;
  saveState: SaveState;
}

/**
 * A line to bring into view in the file viewer, and the characters on it to mark.
 *
 * The nonce is what makes asking for the same line twice move the view twice: a reader who
 * scrolled away from a search result and clicks it again expects to be taken back.
 */
export interface Reveal {
  path: string;
  line: number;
  /** Character offsets into the line, `[start, end)`; equal when only the line is known. */
  start: number;
  end: number;
  nonce: number;
}

export interface WorkspaceIdeState {
  workspaces: WorkspaceSummary[];
  workspaceId: string | null;
  shared: WorkspaceSharedState | null;
  tree: WorkspaceTreeNode[];
  git: WorkspaceGitStatus | null;
  openFiles: Record<string, OpenFile>;
  /**
   * The tabs on screen, in order.
   *
   * The shared state's list plus anything held back from a remote close, which is why the pane
   * reads this rather than `shared.orderedOpenPaths` directly.
   */
  visibleOpenPaths: string[];
  activePath: string | null;
  loadingPath: string | null;
  /** The last line asked for, which the viewer scrolls to when that file is on screen. */
  reveal: Reveal | null;
  error: string | null;
  preferences: WorkspaceIdePreferences;
}

export interface WorkspaceIde extends WorkspaceIdeState {
  client: WorkspaceIdeClient;
  selectWorkspace(id: string): void;
  /** Open a file as a tab of its own, optionally at a line. */
  openPath(path: string, line?: number): void;
  /**
   * Show a file in the preview slot, at a line: what a text search result does. Opened as source,
   * because a rendered file has no lines to scroll to.
   */
  previewPath(path: string, line: number, start: number, end: number): void;
  closePath(path: string): void;
  activate(path: string): void;
  reorderTabs(paths: string[]): void;
  setDirectoryExpanded(path: string, expanded: boolean): void;
  edit(path: string, text: string): void;
  togglePreview(path: string): void;
  useHostVersion(path: string): void;
  keepMyVersion(path: string): void;
  update(change: Partial<WorkspaceIdePreferences>): void;
  /**
   * Put a failure in front of the reader.
   *
   * Exported so the surface's own calls -- adding, renaming and removing a workspace -- report
   * through the banner every other failure here uses, rather than through a modal `alert` that
   * blocks the page and cannot be styled or read back by a test.
   */
  reportError(message: string): void;
  dismissError(): void;
  isPreview(path: string): boolean;
}

export function useWorkspaceIde(transport: AgentHttpTransport): WorkspaceIde {
  const client = useMemo(() => new WorkspaceIdeClient(transport), [transport]);
  // Written from the setter, rather than beside each of the calls that change it: that is how one
  // of those ends up forgotten (AGENTS.md, "Panel state").
  const [preferences, setPreferences] = usePersistentState(loadWorkspaceIdePreferences, storeWorkspaceIdePreferences);
  const [error, setError] = useState<string | null>(null);

  // The roster, read once and then kept current by the workspace stream, which writes each new
  // roster into the same cache entry.
  const workspacesKey = useMemo(() => ["workspaces", sourceKey(client)] as const, [client]);
  const listed = usePanelQuery({
    queryKey: workspacesKey,
    queryFn: () => client.listWorkspaces().then((answer) => answer.workspaces),
  });
  const workspaces = listed.data ?? NO_WORKSPACES;
  const setWorkspaces = useCallback(
    (next: WorkspaceSummary[]) => panelQueryClient.setQueryData(workspacesKey, next),
    [workspacesKey],
  );
  // A failed roster read shows in the banner like every other failure, until it is dismissed.
  const [dismissedListError, setDismissedListError] = useState<unknown>(null);
  const shownError = error ?? (listed.error && listed.error !== dismissedListError
    ? describe(listed.error, "Could not load workspaces.")
    : null);

  const update = useCallback((change: Partial<WorkspaceIdePreferences>) => {
    setPreferences((current) => ({ ...current, ...change }));
  }, []);

  /**
   * The workspace this reader is in.
   *
   * Re-resolved against the roster rather than trusted: a stored id whose workspace was removed
   * would otherwise address a workspace that cannot exist, and every request would 404 with no
   * way for the reader to get out of it.
   */
  const workspaceId = useMemo(() => {
    const stored = preferences.workspaceId;
    if (stored && workspaces.some((workspace) => workspace.id === stored)) return stored;
    return workspaces[0]?.id ?? null;
  }, [preferences.workspaceId, workspaces]);

  // Read by callbacks that must not re-create on every keystroke. The revision moves with every
  // save, and a callback that closed over it would write against a stale one.
  /**
   * Everything below belongs to one workspace of one client, and starts empty when either changes.
   * A stale open file from another workspace is the bug this prevents: same path, different bytes.
   */
  const scope = `${sourceKey(client)}:${workspaceId ?? ""}`;
  const [shared, setShared] = useStateFor<WorkspaceSharedState | null>(scope, () => null);
  const [tree, setTree] = useStateFor<WorkspaceTreeNode[]>(scope, () => []);
  const [git, setGit] = useStateFor<WorkspaceGitStatus | null>(scope, () => null);
  const [openFiles, setOpenFiles] = useStateFor<Record<string, OpenFile>>(scope, () => ({}));
  const [reveal, setReveal] = useStateFor<Reveal | null>(scope, () => null);

  const sharedRef = useLatestRef(shared);
  const openFilesRef = useLatestRef(openFiles);

  /**
   * Which workspace's requests are current, so an answer from the previous one is dropped.
   *
   * Ported from `WorkspaceIDEController.requestGeneration`. Resetting the state when the workspace
   * changes is not enough on its own: a read already in flight resolves afterwards and writes its
   * file into the new workspace's state, which is the same path holding another project's bytes.
   */
  const generationRef = useLatestRef(scope);

  // Above the subscription, which reloads a file that changed on disk while it was clean.
  const reload = useCallback(async (path: string) => {
    if (!workspaceId) return;
    const generation = generationRef.current;
    try {
      const { file } = await client.readFile(workspaceId, path);
      if (generation !== generationRef.current) return;
      const disk = file.text ?? "";
      // Text this tab had typed and not written down comes back with the file, along with whether
      // the file moved underneath it while it was gone.
      const kept = reconcileDraft(loadDraft(workspaceId, path), disk, file.revision);
      if (kept.state === "identical") removeDraft(workspaceId, path);
      setOpenFiles((current) => ({
        ...current,
        [path]: {
          path,
          kind: file.kind,
          text: kept.state === "unsaved" || kept.state === "conflict" ? kept.text : disk,
          revision: file.revision,
          saveState: kept.state === "unsaved"
            ? "dirty"
            : kept.state === "conflict"
              ? "conflict"
              : "clean",
        },
      }));
    } catch (cause) {
      if (generation !== generationRef.current) return;
      setError(describe(cause, `Could not open ${path.split("/").pop() ?? path}.`));
    }
  }, [client, workspaceId]);

  // Follow the workspace. Its state above has already started empty for it.
  useSubscription(workspaceId ? scope : null, () => {
    if (!workspaceId) return;
    return client.subscribe(
      workspaceId,
      (event: WorkspaceStreamEvent) => {
        switch (event.type) {
          case "workspaces":
            setWorkspaces(event.workspaces);
            break;
          case "sharedState":
            // A file another reader closed goes only if this reader has nothing unsaved in it.
            // One with unsaved text is kept, and `visibleOpenPaths` puts its tab back, because a
            // remote close must never be able to take away work that was never written down.
            setOpenFiles((current) => {
              const remote = new Set(event.state.orderedOpenPaths);
              const next: Record<string, OpenFile> = {};
              for (const [path, file] of Object.entries(current)) {
                if (remote.has(path) || file.saveState !== "clean") next[path] = file;
              }
              return next;
            });
            setShared(event.state);
            break;
          case "tree":
            setTree(event.tree);
            break;
          case "git":
            setGit(event.status);
            break;
          case "changed": {
            // A file that changed on disk while it was clean is reloaded; one with unsaved work
            // becomes a conflict rather than being overwritten under the reader's hands.
            //
            // Decided from the ref and not inside the state updater: React may run an updater
            // twice, and a reload started in there would be two requests for one event.
            const held = openFilesRef.current;
            const conflicted = event.changedPaths.filter(
              (path) => held[path] && held[path]!.saveState !== "clean",
            );
            for (const path of event.changedPaths) {
              if (held[path]?.saveState === "clean") void reload(path);
            }
            if (conflicted.length > 0) {
              setOpenFiles((current) => {
                let next = current;
                for (const path of conflicted) {
                  const file = next[path];
                  if (file) next = { ...next, [path]: { ...file, saveState: "conflict" } };
                }
                return next;
              });
            }
            break;
          }
        }
      },
      (reason) => setError(reason),
    );
  });

  /**
   * The tabs on screen: what the shared state says is open, plus anything held back from a remote
   * close. Ported from `WorkspaceIDEController.visibleOpenPaths`.
   */
  const visibleOpenPaths = useMemo(() => {
    const remote = shared?.orderedOpenPaths ?? [];
    const held = Object.keys(openFiles).filter((path) => !remote.includes(path));
    return held.length === 0 ? remote : [...remote, ...held];
  }, [shared, openFiles]);

  const activePath = useMemo(() => {
    const stored = workspaceId ? preferences.activePathByWorkspace[workspaceId] : undefined;
    if (stored && visibleOpenPaths.includes(stored)) return stored;
    return visibleOpenPaths[0] ?? null;
  }, [visibleOpenPaths, preferences.activePathByWorkspace, workspaceId]);

  // Load whatever is active and not yet in hand. One query rather than a load beside every place
  // that can change the active path, of which there are five. `reload` puts the file in
  // `openFiles`, which is what turns the query off again.
  const loading = usePanelQuery({
    queryKey: ["workspace-open-file", scope, activePath],
    queryFn: () => reload(activePath!).then(() => true),
    enabled: activePath !== null && openFiles[activePath] === undefined,
  });
  const loadingPath = loading.isFetching ? activePath : null;

  /**
   * Send one shared-state operation, and adopt the state it answers with.
   *
   * A revision conflict is recovered from rather than reported: another reader moved first, so the
   * fix is to take their state and let the reader try again, not to show them an error about a
   * revision number.
   */
  const applyOperation = useCallback(async (operation: WorkspaceOperation) => {
    const current = sharedRef.current;
    if (!workspaceId || !current) return;
    try {
      const { state } = await client.applyOperation(workspaceId, current.revision, operation);
      setShared(state);
    } catch (cause) {
      if (cause instanceof WorkspaceRequestError && cause.code === "revisionConflict") {
        try {
          const { tree: refreshed } = await client.tree(workspaceId);
          setTree(refreshed);
        } catch {
          // The stream will deliver it; this is only to shorten the wait.
        }
        return;
      }
      setError(describe(cause, "That change could not be applied."));
    }
  }, [client, workspaceId]);

  const setActivePath = useCallback((path: string) => {
    if (!workspaceId) return;
    // Through the functional setter, not by re-reading storage: an update still queued is in the
    // updater's `current` and not yet in storage, so reading it back here would drop it.
    setPreferences((current) => ({
      ...current,
      activePathByWorkspace: { ...current.activePathByWorkspace, [workspaceId]: path },
    }));
  }, [workspaceId]);

  // Everything between a keystroke and the bytes landing on disk. Its own file because that is
  // what it was in the Swift too (`WorkspaceIDEControllerEditing`), and because it is the half with
  // a reader's unsaved work in it.
  const writing = useWorkspaceIdeWriting({
    client,
    workspaceId,
    generationRef,
    openFilesRef,
    setOpenFiles,
    setError,
    applyOperation,
    reload,
  });

  const revealLine = useCallback((path: string, line: number, start: number, end: number) => {
    setReveal((current) => ({ path, line, start, end, nonce: (current?.nonce ?? 0) + 1 }));
  }, []);

  const openPath = useCallback((path: string, line?: number) => {
    setActivePath(path);
    if (line !== undefined) revealLine(path, line, 0, 0);
    void applyOperation({ type: "open", path });
  }, [applyOperation, setActivePath, revealLine]);

  const previewPath = useCallback((path: string, line: number, start: number, end: number) => {
    if (!workspaceId) return;
    setActivePath(path);
    revealLine(path, line, start, end);
    // Source, as a choice the reader can see and undo with the toggle, rather than a preview that
    // quietly will not render: a markdown result lands on its line instead of on the top of a
    // rendered page with the line nowhere in it.
    setPreferences((current) => {
      const held = current.fileViewByWorkspace[workspaceId] ?? {};
      if (held[path] === "source") return current;
      return {
        ...current,
        fileViewByWorkspace: { ...current.fileViewByWorkspace, [workspaceId]: { ...held, [path]: "source" } },
      };
    });
    void applyOperation({ type: "preview", path });
  }, [applyOperation, setActivePath, revealLine, workspaceId]);

  /** Typing into the preview keeps it, the way VS Code does: an edited file is not a glance. */
  const writingEdit = writing.edit;
  const edit = useCallback((path: string, text: string) => {
    if (sharedRef.current?.previewPath === path) void applyOperation({ type: "open", path });
    writingEdit(path, text);
  }, [applyOperation, writingEdit]);

  const isPreview = useCallback((path: string) => {
    if (!workspaceId) return false;
    const chosen = preferences.fileViewByWorkspace[workspaceId]?.[path];
    return (chosen ?? defaultFileView(openFiles[path]?.kind)) === "preview";
  }, [preferences.fileViewByWorkspace, workspaceId, openFiles]);

  /**
   * Swap one file between its editor and its rendered preview.
   *
   * A read-only kind has no editor to swap to -- a notebook and a Word document are drawn from a
   * parsed model, and the sidecar refuses a write to either -- so the toggle is not offered for
   * them rather than offered and then refused. The guard is the Swift's `toggleMode`.
   */
  const togglePreview = useCallback((path: string) => {
    if (!workspaceId) return;
    const kind = openFilesRef.current[path]?.kind;
    if (!hasSource(kind)) return;
    setPreferences((current) => {
      const held = current.fileViewByWorkspace[workspaceId] ?? {};
      // Against what is on screen, which is the choice if there is one and the kind's default
      // otherwise. Flipping the stored value alone would make the first press on a markdown file
      // a no-op: nothing is stored, so it would write "preview" over a file already previewed.
      const showing = held[path] ?? defaultFileView(kind);
      return {
        ...current,
        fileViewByWorkspace: {
          ...current.fileViewByWorkspace,
          [workspaceId]: { ...held, [path]: showing === "preview" ? "source" : "preview" },
        },
      };
    });
  }, [workspaceId]);

  return {
    client,
    workspaces,
    workspaceId,
    shared,
    tree,
    git,
    openFiles,
    visibleOpenPaths,
    activePath,
    loadingPath,
    reveal,
    error: shownError,
    preferences,
    // Normalised here rather than at each caller: both the roster's "No workspaces" option and
    // removing the last project arrive as an empty string, and storing that would persist a
    // workspace id that can never match one.
    selectWorkspace: useCallback((id: string) => update({ workspaceId: id || null }), [update]),
    reportError: setError,
    openPath,
    previewPath,
    closePath: writing.closePath,
    activate: setActivePath,
    reorderTabs: useCallback(
      (paths: string[]) => void applyOperation({ type: "reorder", orderedPaths: paths }),
      [applyOperation],
    ),
    setDirectoryExpanded: useCallback(
      (path: string, expanded: boolean) =>
        void applyOperation({ type: expanded ? "expand" : "collapse", path }),
      [applyOperation],
    ),
    edit,
    togglePreview,
    useHostVersion: writing.useHostVersion,
    keepMyVersion: writing.keepMyVersion,
    update,
    dismissError: useCallback(() => {
      setError(null);
      setDismissedListError(listed.error);
    }, [listed.error]),
    isPreview,
  };
}

const NO_WORKSPACES: WorkspaceSummary[] = [];

function describe(cause: unknown, fallback: string): string {
  return cause instanceof WorkspaceRequestError ? cause.message : fallback;
}

export { DEFAULT_WORKSPACE_IDE_PREFERENCES };
