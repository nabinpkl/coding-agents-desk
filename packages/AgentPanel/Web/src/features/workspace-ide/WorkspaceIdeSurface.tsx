// The workspace IDE, as a panel surface.
//
// Three panes that used to be an AppKit split view holding two WKWebViews and a PTY terminal:
// `WorkspaceIDEWindowContentView` measured them and `WorkspaceIDEPaneDivider` dragged them. They
// are CSS here, which is the whole reason the port was worth doing -- the layout is now something
// a reader changes by saving a file.

import { useCallback, useEffect, useRef, useState } from "react";
import { FolderPlus } from "lucide-react";
import type { AgentHttpTransport } from "@/features/activity-feed/transport/AgentHttpTransport";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import { EditorPane } from "@/features/workspace-ide/editor/EditorPane";
import { useCommitDiffTab } from "@/features/workspace-ide/history/CommitDiff";
import { PaneDivider } from "@/features/workspace-ide/PaneDivider";
import { QuickOpen } from "@/features/workspace-ide/search/QuickOpen";
import { useContentSearch } from "@/features/workspace-ide/search/useContentSearch";
import { useSearchShortcuts } from "@/features/workspace-ide/search/useSearchShortcuts";
import { WorkspacePicker } from "@/features/workspace-ide/sidebar/WorkspacePicker";
import { WorkspaceSidebar } from "@/features/workspace-ide/sidebar/WorkspaceSidebar";
import { WorkspaceIdeStatusBar } from "@/features/workspace-ide/WorkspaceIdeStatusBar";
import { WorkspaceTerminal } from "@/features/workspace-ide/WorkspaceTerminal";
import { useWorkspaceIde } from "@/features/workspace-ide/useWorkspaceIde";
import {
  clampFraction,
  SIDEBAR_FRACTION_RANGE,
  TERMINAL_FRACTION_RANGE,
} from "@/features/workspace-ide/workspaceIdePreferences";

export function WorkspaceIdeSurface({
  transport,
  feed,
}: {
  transport: AgentHttpTransport;
  feed: SidecarDataSource;
}) {
  const ide = useWorkspaceIde(transport);
  // The editor's diff tab. Owned here because two panes share it: the status bar's history points
  // it at a file, and the editor draws it.
  const diff = useCommitDiffTab();
  const frame = useRef<HTMLDivElement | null>(null);
  // The editor pane, handed to the status bar so its history popup can tell a pointer landing in
  // the editor -- where the diff it opened is being read -- from one landing anywhere else.
  const editor = useRef<HTMLDivElement | null>(null);
  const [adding, setAdding] = useState(false);
  const [picking, setPicking] = useState(false);
  const [quickOpen, setQuickOpen] = useState(false);
  // Held here rather than in the section, so the results survive switching to the Explorer and
  // back -- which is how a reader works through them, one file at a time.
  const search = useContentSearch(ide.client, ide.workspaceId);
  const searchField = useRef<HTMLInputElement | null>(null);
  const [focusSearch, setFocusSearch] = useState(0);

  // After the render that mounted the section, since the field does not exist until then.
  useEffect(() => {
    if (focusSearch === 0) return;
    searchField.current?.focus();
    searchField.current?.select();
  }, [focusSearch]);

  const showSearch = useCallback(() => {
    ide.update({ section: "search", sidebarVisible: true });
    setFocusSearch((count) => count + 1);
  }, [ide]);
  const hasWorkspace = ide.workspaceId !== null;
  const openQuickOpen = useCallback(() => {
    if (hasWorkspace) setQuickOpen(true);
  }, [hasWorkspace]);
  useSearchShortcuts({ onQuickOpen: openQuickOpen, onSearch: showSearch });

  /** A search result: the file in the preview tab, on its line, with the diff put away. */
  const hideDiff = diff.hide;
  const openResult = useCallback((path: string, line: number, start: number, end: number) => {
    hideDiff();
    ide.previewPath(path, line, start, end);
  }, [ide, hideDiff]);

  // Fractions rather than pixels, because a fraction is what survives the window being resized,
  // and this panel is read on a phone and on an 8K desk within the same hour.
  const growSidebar = useCallback((pixels: number) => {
    const width = frame.current?.clientWidth ?? 0;
    if (width === 0) return;
    ide.update({
      sidebarFraction: clampFraction(
        ide.preferences.sidebarFraction + pixels / width,
        SIDEBAR_FRACTION_RANGE,
      ),
    });
  }, [ide]);

  // The editor is the leading pane above this divider, so growing it shrinks the terminal.
  const growEditor = useCallback((pixels: number) => {
    const height = frame.current?.clientHeight ?? 0;
    if (height === 0) return;
    ide.update({
      terminalFraction: clampFraction(
        ide.preferences.terminalFraction - pixels / height,
        TERMINAL_FRACTION_RANGE,
      ),
    });
  }, [ide]);

  /**
   * The status bar's branch, taking the reader to the changes it is counting.
   *
   * It reveals the sidebar as well as selecting the section, because the commonest time to ask
   * what changed is while the sidebar is hidden -- that is when the bar's count is the only
   * number on screen, and a click that selected a section inside a pane nobody can see would
   * read as a dead control.
   */
  const showSourceControl = useCallback(() => {
    ide.update({ section: "sourceControl", sidebarVisible: true });
  }, [ide]);

  /**
   * A source-control row, opening what changed rather than the file itself: the list is a list of
   * changes, and the diff's own "Open file" is one click from the file when that is what is wanted.
   * Both status letters travel, so a path deleted in the index or the worktree offers no file.
   */
  const openDiffChange = diff.openChange;
  const openChange = useCallback((path: string) => {
    const entry = ide.git?.entries.find((candidate) => candidate.relativePath === path);
    openDiffChange(path, [entry?.indexStatus, entry?.workTreeStatus].filter(Boolean).join(""));
  }, [ide.git, openDiffChange]);

  /** Every roster call fails the same way: into the banner, named by what was attempted. */
  const report = useCallback(
    (attempt: string) => (cause: unknown) =>
      ide.reportError(`${attempt}: ${cause instanceof Error ? cause.message : String(cause)}`),
    [ide],
  );

  /**
   * Register the folder the picker was looking at.
   *
   * The name comes from the last path component rather than being asked for: it is right nearly
   * always, and the roster can rename it in two clicks when it is not.
   */
  const chooseWorkspace = useCallback(
    (root: string) => {
      setPicking(false);
      setAdding(true);
      void ide.client.addWorkspace(root, root.split("/").pop() || root)
        .then(({ workspace }) => ide.selectWorkspace(workspace.id))
        .catch(report("Could not add that workspace"))
        .finally(() => setAdding(false));
    },
    [ide, report],
  );

  const renameWorkspace = useCallback(
    (id: string, name: string) => {
      void ide.client.renameWorkspace(id, name).catch(report("Could not rename that workspace"));
    },
    [ide, report],
  );

  const reorderWorkspaces = useCallback(
    (ids: string[]) => {
      void ide.client.reorderWorkspaces(ids).catch(report("Could not reorder the workspaces"));
    },
    [ide, report],
  );

  /**
   * Unregister a project, and move the reader somewhere that still exists.
   *
   * Selecting the neighbour here rather than waiting for the roster event: the stream will report
   * the new list either way, but between the removal and that event the panel would be pointed at
   * a workspace the sidecar no longer knows, and every call it makes in that window answers 404.
   */
  const removeWorkspace = useCallback(
    (id: string) => {
      const remaining = ide.workspaces.filter((workspace) => workspace.id !== id);
      void ide.client.removeWorkspace(id)
        .then(() => {
          if (ide.workspaceId === id) ide.selectWorkspace(remaining[0]?.id ?? "");
        })
        .catch(report("Could not remove that workspace"));
    },
    [ide, report],
  );

  if (ide.workspaces.length === 0) {
    return (
      <div className="grid h-full place-items-center p-8 text-center">
        <div className="grid max-w-sm justify-items-center gap-3">
          <FolderPlus aria-hidden className="size-8 text-muted-foreground" />
          <p className="m-0 text-foreground">No workspaces yet</p>
          <p className="m-0 text-sm text-muted-foreground">
            Add a project directory on this machine and the IDE will browse it.
          </p>
          <button
            type="button"
            disabled={adding}
            onClick={() => setPicking(true)}
            className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground outline-none
              transition-colors hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-primary
              focus-visible:ring-offset-2 disabled:opacity-60"
          >
            {adding ? "Adding…" : "Add a workspace"}
          </button>
          {ide.error ? <p className="m-0 text-sm text-destructive">{ide.error}</p> : null}
        </div>
        {picking
          ? (
            <WorkspacePicker
              browse={ide.client.browse.bind(ide.client)}
              onChoose={chooseWorkspace}
              onCancel={() => setPicking(false)}
            />
          )
          : null}
      </div>
    );
  }

  const { preferences } = ide;
  const current = ide.workspaces.find((workspace) => workspace.id === ide.workspaceId);
  return (
    <div ref={frame} className="flex h-full min-h-0 w-full flex-col">
      {ide.error
        ? (
          <div
            role="status"
            className="flex shrink-0 items-center gap-2 border-b border-border bg-destructive/10
              px-3 py-1.5 text-xs text-destructive"
          >
            <span className="flex-1">{ide.error}</span>
            <button type="button" onClick={ide.dismissError} className="underline">Dismiss</button>
          </div>
        )
        : null}

      <div className="flex min-h-0 flex-1">
        {preferences.sidebarVisible
          ? (
            <>
              <div
                className="min-w-0 shrink-0"
                style={{ width: `${preferences.sidebarFraction * 100}%` }}
              >
                <WorkspaceSidebar
                  workspaces={ide.workspaces}
                  workspaceId={ide.workspaceId}
                  section={preferences.section}
                  tree={ide.tree}
                  git={ide.git}
                  activePath={ide.activePath}
                  onSelectWorkspace={ide.selectWorkspace}
                  onSelectSection={(section) => ide.update({ section })}
                  onAddWorkspace={() => setPicking(true)}
                  onRenameWorkspace={renameWorkspace}
                  onRemoveWorkspace={removeWorkspace}
                  onReorderWorkspaces={reorderWorkspaces}
                  onOpen={ide.openPath}
                  onOpenChange={openChange}
                  changePath={diff.active && diff.target?.commit === null ? diff.target.path : null}
                  onToggleDirectory={ide.setDirectoryExpanded}
                  search={search}
                  searchField={searchField}
                  onOpenResult={openResult}
                />
              </div>
              <PaneDivider axis="vertical" label="Resize sidebar" onGrow={growSidebar} />
            </>
          )
          : null}

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div ref={editor} className="min-h-0 flex-1">
            <EditorPane ide={ide} diff={diff} onQuickOpen={openQuickOpen} />
          </div>
          {preferences.terminalVisible
            ? (
              <>
                <PaneDivider axis="horizontal" label="Resize terminal" onGrow={growEditor} />
                <div
                  className="min-h-0 shrink-0 border-t border-border"
                  style={{ height: `${preferences.terminalFraction * 100}%` }}
                >
                  {/* A shell in the workspace being browsed, through the sidecar's PTY manager.
                      Keyed on the workspace so switching projects gets that project's shell
                      rather than the previous one re-pointed: the hook re-attaches on a context
                      change, and a remount is the honest way to say the terminal is a different
                      one. */}
                  {current
                    ? (
                      <WorkspaceTerminal
                        key={current.id}
                        feed={feed}
                        workspaceName={current.name}
                        workspacePath={current.root}
                      />
                    )
                    : (
                      <p className="p-3 text-xs text-muted-foreground">
                        Choose a workspace to open a shell in it.
                      </p>
                    )}
                </div>
              </>
            )
            : null}
        </div>
      </div>

      {/* Full width, under the sidebar as well as the editor: it reports on the workspace rather
          than on either pane, and it is the strip that survives both of them being hidden. */}
      <WorkspaceIdeStatusBar
        git={ide.git}
        client={ide.client}
        workspaceId={ide.workspaceId}
        terminalVisible={preferences.terminalVisible}
        editor={editor}
        showingDiff={diff.target}
        onOpenDiff={diff.open}
        onShowSourceControl={showSourceControl}
        onToggleTerminal={() => ide.update({ terminalVisible: !preferences.terminalVisible })}
      />

      {picking
        ? (
          <WorkspacePicker
            browse={ide.client.browse.bind(ide.client)}
            onChoose={chooseWorkspace}
            onCancel={() => setPicking(false)}
          />
        )
        : null}

      {quickOpen && ide.workspaceId
        ? (
          <QuickOpen
            client={ide.client}
            workspaceId={ide.workspaceId}
            openPaths={ide.visibleOpenPaths}
            onOpen={(path, line) => {
              setQuickOpen(false);
              diff.hide();
              ide.openPath(path, line ?? undefined);
            }}
            onClose={() => setQuickOpen(false)}
          />
        )
        : null}
    </div>
  );
}
