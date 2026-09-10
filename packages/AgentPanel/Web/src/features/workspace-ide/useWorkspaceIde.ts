// The IDE's state, and every intent that changes it.
//
// This is what `WorkspaceIDEController` was: the thing between the projections arriving from the
// sidecar and the panes drawing them. It is a hook rather than a store because the projection is
// already the single source of truth -- taking props from it, not from a second copy, is the one
// piece of ADR-0077 that survives its own supersession.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import {
  DEFAULT_WORKSPACE_IDE_PREFERENCES,
  loadWorkspaceIdePreferences,
  storeWorkspaceIdePreferences,
  type WorkspaceIdePreferences,
} from "@/features/workspace-ide/workspaceIdePreferences";

/** How long an edit rests before it is written. Ported from the Swift's autosave delay. */
const AUTOSAVE_DELAY_MS = 900;

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

export interface WorkspaceIdeState {
  workspaces: WorkspaceSummary[];
  workspaceId: string | null;
  shared: WorkspaceSharedState | null;
  tree: WorkspaceTreeNode[];
  git: WorkspaceGitStatus | null;
  openFiles: Record<string, OpenFile>;
  activePath: string | null;
  loadingPath: string | null;
  error: string | null;
  preferences: WorkspaceIdePreferences;
}

export interface WorkspaceIde extends WorkspaceIdeState {
  client: WorkspaceIdeClient;
  selectWorkspace(id: string): void;
  openPath(path: string): void;
  closePath(path: string): void;
  activate(path: string): void;
  reorderTabs(paths: string[]): void;
  setDirectoryExpanded(path: string, expanded: boolean): void;
  edit(path: string, text: string): void;
  togglePreview(path: string): void;
  useHostVersion(path: string): void;
  keepMyVersion(path: string): void;
  update(change: Partial<WorkspaceIdePreferences>): void;
  dismissError(): void;
  isPreview(path: string): boolean;
}

export function useWorkspaceIde(transport: AgentHttpTransport): WorkspaceIde {
  const client = useMemo(() => new WorkspaceIdeClient(transport), [transport]);
  const [preferences, setPreferences] = useState(loadWorkspaceIdePreferences);
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [shared, setShared] = useState<WorkspaceSharedState | null>(null);
  const [tree, setTree] = useState<WorkspaceTreeNode[]>([]);
  const [git, setGit] = useState<WorkspaceGitStatus | null>(null);
  const [openFiles, setOpenFiles] = useState<Record<string, OpenFile>>({});
  const [loadingPath, setLoadingPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // One effect on the value, rather than a write beside each of the calls that change it: that is
  // how one of those ends up forgotten (AGENTS.md, "Panel state").
  useEffect(() => storeWorkspaceIdePreferences(preferences), [preferences]);

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
  const sharedRef = useRef<WorkspaceSharedState | null>(null);
  sharedRef.current = shared;
  const openFilesRef = useRef(openFiles);
  openFilesRef.current = openFiles;

  useEffect(() => {
    let cancelled = false;
    client.listWorkspaces()
      .then(({ workspaces: listed }) => {
        if (!cancelled) setWorkspaces(listed);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(describe(cause, "Could not load workspaces."));
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  /**
   * Follow the workspace, and drop everything belonging to the previous one.
   *
   * The reset is inside the effect rather than in the selection handler so it happens exactly once
   * per workspace, including on the first mount and on a transport change. A stale open file from
   * another workspace is the bug this prevents: same path, different bytes.
   */
  useEffect(() => {
    if (!workspaceId) return;
    setShared(null);
    setTree([]);
    setGit(null);
    setOpenFiles({});
    setLoadingPath(null);

    return client.subscribe(
      workspaceId,
      (event: WorkspaceStreamEvent) => {
        switch (event.type) {
          case "workspaces":
            setWorkspaces(event.workspaces);
            break;
          case "sharedState":
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
    // `reload` is stable for a given client and workspace, which is what this effect keys on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, workspaceId]);

  const reload = useCallback(async (path: string) => {
    if (!workspaceId) return;
    try {
      const { file } = await client.readFile(workspaceId, path);
      setOpenFiles((current) => ({
        ...current,
        [path]: {
          path,
          kind: file.kind,
          text: file.text ?? "",
          revision: file.revision,
          saveState: "clean",
        },
      }));
    } catch (cause) {
      setError(describe(cause, `Could not open ${path.split("/").pop() ?? path}.`));
    }
  }, [client, workspaceId]);

  const activePath = useMemo(() => {
    const open = shared?.orderedOpenPaths ?? [];
    const stored = workspaceId ? preferences.activePathByWorkspace[workspaceId] : undefined;
    if (stored && open.includes(stored)) return stored;
    return open[0] ?? null;
  }, [shared, preferences.activePathByWorkspace, workspaceId]);

  // Load whatever is active and not yet in hand. One effect rather than a load beside every place
  // that can change the active path, of which there are five.
  useEffect(() => {
    if (!activePath || openFilesRef.current[activePath] || loadingPath === activePath) return;
    setLoadingPath(activePath);
    void reload(activePath).finally(() => {
      setLoadingPath((current) => (current === activePath ? null : current));
    });
  }, [activePath, loadingPath, reload]);

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
    // Through the functional setter, not by re-reading storage: the stored value lags the value in
    // hand by one effect, so reading it back here would drop whichever change had not landed yet.
    setPreferences((current) => ({
      ...current,
      activePathByWorkspace: { ...current.activePathByWorkspace, [workspaceId]: path },
    }));
  }, [workspaceId]);

  const openPath = useCallback((path: string) => {
    setActivePath(path);
    void applyOperation({ type: "open", path });
  }, [applyOperation, setActivePath]);

  const closePath = useCallback((path: string) => {
    setOpenFiles((current) => {
      const next = { ...current };
      delete next[path];
      return next;
    });
    void applyOperation({ type: "close", path });
  }, [applyOperation]);

  // Autosave. One timer per path, cleared when the path saves or closes.
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    };
  }, []);

  const save = useCallback(async (path: string) => {
    const file = openFilesRef.current[path];
    if (!workspaceId || !file || file.saveState !== "dirty") return;
    setOpenFiles((current) => {
      const held = current[path];
      return held ? { ...current, [path]: { ...held, saveState: "saving" } } : current;
    });
    try {
      const outcome = await client.writeFile(workspaceId, path, file.revision, file.text);
      setOpenFiles((current) => {
        const held = current[path];
        if (!held) return current;
        if (outcome.status === "conflict") {
          return { ...current, [path]: { ...held, saveState: "conflict" } };
        }
        // The text may have moved on while the write was in flight; if it did, the file is dirty
        // again against the new revision rather than clean against text nobody has.
        const stillCurrent = held.text === file.text;
        return {
          ...current,
          [path]: {
            ...held,
            revision: outcome.written.revision,
            saveState: stillCurrent ? "clean" : "dirty",
          },
        };
      });
    } catch (cause) {
      setOpenFiles((current) => {
        const held = current[path];
        return held ? { ...current, [path]: { ...held, saveState: "dirty" } } : current;
      });
      setError(describe(cause, "The file could not be saved."));
    }
  }, [client, workspaceId]);

  const edit = useCallback((path: string, text: string) => {
    setOpenFiles((current) => {
      const file = current[path];
      if (!file) return current;
      // A conflicted file stays conflicted while it is edited: the reader has to resolve it, and
      // quietly clearing the flag on the next keystroke would lose that.
      const saveState: SaveState = file.saveState === "conflict" ? "conflict" : "dirty";
      return { ...current, [path]: { ...file, text, saveState } };
    });
    const existing = timers.current.get(path);
    if (existing) clearTimeout(existing);
    timers.current.set(path, setTimeout(() => {
      timers.current.delete(path);
      void save(path);
    }, AUTOSAVE_DELAY_MS));
  }, [save]);

  const useHostVersion = useCallback((path: string) => {
    const timer = timers.current.get(path);
    if (timer) clearTimeout(timer);
    timers.current.delete(path);
    void reload(path);
  }, [reload]);

  /**
   * Keep the local text, re-based on whatever is on disk now.
   *
   * Re-reading first is what makes the next write succeed: the draft's revision is stale by
   * definition once a conflict has been reported, so keeping it would conflict again forever.
   */
  const keepMyVersion = useCallback(async (path: string) => {
    if (!workspaceId) return;
    const retained = openFilesRef.current[path]?.text;
    if (retained === undefined) return;
    try {
      const { file } = await client.readFile(workspaceId, path);
      setOpenFiles((current) => {
        const held = current[path];
        return held
          ? { ...current, [path]: { ...held, text: retained, revision: file.revision, saveState: "dirty" } }
          : current;
      });
      void save(path);
    } catch (cause) {
      setError(describe(cause, "Could not fetch the latest revision."));
    }
  }, [client, save, workspaceId]);

  const isPreview = useCallback((path: string) => {
    if (!workspaceId) return false;
    return (preferences.previewPathsByWorkspace[workspaceId] ?? []).includes(path);
  }, [preferences.previewPathsByWorkspace, workspaceId]);

  const togglePreview = useCallback((path: string) => {
    if (!workspaceId) return;
    setPreferences((current) => {
      const held = current.previewPathsByWorkspace[workspaceId] ?? [];
      const next = held.includes(path) ? held.filter((one) => one !== path) : [...held, path];
      return {
        ...current,
        previewPathsByWorkspace: { ...current.previewPathsByWorkspace, [workspaceId]: next },
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
    activePath,
    loadingPath,
    error,
    preferences,
    selectWorkspace: useCallback((id: string) => update({ workspaceId: id }), [update]),
    openPath,
    closePath,
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
    useHostVersion,
    keepMyVersion: useCallback((path: string) => void keepMyVersion(path), [keepMyVersion]),
    update,
    dismissError: useCallback(() => setError(null), []),
    isPreview,
  };
}

function describe(cause: unknown, fallback: string): string {
  return cause instanceof WorkspaceRequestError ? cause.message : fallback;
}

export { DEFAULT_WORKSPACE_IDE_PREFERENCES };
