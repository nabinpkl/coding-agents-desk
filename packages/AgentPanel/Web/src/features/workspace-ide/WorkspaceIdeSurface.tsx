// The workspace IDE, as a panel surface.
//
// Three panes that used to be an AppKit split view holding two WKWebViews and a PTY terminal:
// `WorkspaceIDEWindowContentView` measured them and `WorkspaceIDEPaneDivider` dragged them. They
// are CSS here, which is the whole reason the port was worth doing -- the layout is now something
// a reader changes by saving a file.

import { useCallback, useRef, useState } from "react";
import { FolderPlus } from "lucide-react";
import type { AgentHttpTransport } from "@/features/activity-feed/transport/AgentHttpTransport";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import { TerminalsSurface } from "@/features/terminal/TerminalsSurface";
import { EditorPane } from "@/features/workspace-ide/editor/EditorPane";
import { PaneDivider } from "@/features/workspace-ide/PaneDivider";
import { WorkspaceSidebar } from "@/features/workspace-ide/sidebar/WorkspaceSidebar";
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
  const frame = useRef<HTMLDivElement | null>(null);
  const [adding, setAdding] = useState(false);

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

  const addWorkspace = useCallback(() => {
    // A prompt rather than a directory picker: the browser cannot hand a page an absolute path,
    // and the sidecar needs one. It refuses anything that is not an existing, non-symlinked
    // directory, so a typo is answered rather than registered.
    const root = window.prompt("Absolute path of the project to add");
    if (!root) return;
    setAdding(true);
    void ide.client.addWorkspace(root.trim())
      .then(({ workspace }) => ide.selectWorkspace(workspace.id))
      .catch((cause: unknown) => {
        window.alert(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => setAdding(false));
  }, [ide]);

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
            onClick={addWorkspace}
            className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground outline-none
              transition-colors hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-primary
              focus-visible:ring-offset-2 disabled:opacity-60"
          >
            {adding ? "Adding…" : "Add a workspace"}
          </button>
          {ide.error ? <p className="m-0 text-sm text-destructive">{ide.error}</p> : null}
        </div>
      </div>
    );
  }

  const { preferences } = ide;
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
                  onAddWorkspace={addWorkspace}
                  onOpen={ide.openPath}
                  onToggleDirectory={ide.setDirectoryExpanded}
                />
              </div>
              <PaneDivider axis="vertical" label="Resize sidebar" onGrow={growSidebar} />
            </>
          )
          : null}

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1">
            <EditorPane ide={ide} />
          </div>
          {preferences.terminalVisible
            ? (
              <>
                <PaneDivider axis="horizontal" label="Resize terminal" onGrow={growEditor} />
                <div
                  className="min-h-0 shrink-0 border-t border-border"
                  style={{ height: `${preferences.terminalFraction * 100}%` }}
                >
                  {/* The panel's own terminal, over tmux through the sidecar. The IDE used to
                      carry its own PTY client for this, which was a second way to reach the same
                      shell. */}
                  <TerminalsSurface feed={feed} />
                </div>
              </>
            )
            : null}
        </div>
      </div>
    </div>
  );
}
