// The sidebar: which workspace, which section, and the section itself.
//
// The branch name used to ride the section nav and is on the IDE's status bar now. It says which
// repository every pane is showing, so it should not go away with the pane it was sitting in.

import type { WorkspaceGitStatus, WorkspaceSummary, WorkspaceTreeNode } from "@agentdesk/agent-feed-wire";
import { SourceControl } from "@/features/workspace-ide/sidebar/SourceControl";
import { changedFileCount } from "@/features/workspace-ide/sidebar/gitTones";
import { SidebarSections } from "@/features/workspace-ide/sidebar/SidebarSections";
import { WorkspaceRoster } from "@/features/workspace-ide/sidebar/WorkspaceRoster";
import { WorkspaceTree } from "@/features/workspace-ide/sidebar/WorkspaceTree";
import type { WorkspaceIdePreferences } from "@/features/workspace-ide/workspaceIdePreferences";

type Section = WorkspaceIdePreferences["section"];

export function WorkspaceSidebar({
  workspaces,
  workspaceId,
  section,
  tree,
  git,
  activePath,
  onSelectWorkspace,
  onSelectSection,
  onAddWorkspace,
  onRenameWorkspace,
  onRemoveWorkspace,
  onReorderWorkspaces,
  onOpen,
  onOpenChange,
  changePath,
  onToggleDirectory,
}: {
  workspaces: WorkspaceSummary[];
  workspaceId: string | null;
  section: Section;
  tree: WorkspaceTreeNode[];
  git: WorkspaceGitStatus | null;
  activePath: string | null;
  onSelectWorkspace: (id: string) => void;
  onSelectSection: (section: Section) => void;
  onAddWorkspace: () => void;
  onRenameWorkspace: (id: string, name: string) => void;
  onRemoveWorkspace: (id: string) => void;
  onReorderWorkspaces: (ids: string[]) => void;
  onOpen: (path: string) => void;
  /** Opens one changed path's uncommitted diff, which is what a source-control row does. */
  onOpenChange: (path: string) => void;
  /** The path whose uncommitted diff the editor is showing, so its row reads as current. */
  changePath: string | null;
  onToggleDirectory: (path: string, expanded: boolean) => void;
}) {
  const changed = changedFileCount(git?.entries ?? []);
  return (
    <div className="flex h-full min-h-0 flex-col border-r border-border bg-background">
      <WorkspaceRoster
        workspaces={workspaces}
        workspaceId={workspaceId}
        onSelect={onSelectWorkspace}
        onAdd={onAddWorkspace}
        onRename={onRenameWorkspace}
        onRemove={onRemoveWorkspace}
        onReorder={onReorderWorkspaces}
      />

      <SidebarSections
        label="Workspace sidebar sections"
        section={section}
        changed={changed}
        onSelect={onSelectSection}
      />

      <section className="min-h-0 flex-1 overflow-auto px-1 pb-4 pt-1">
        {section === "sourceControl"
          ? (
            <SourceControl
              entries={git?.entries ?? []}
              onOpen={onOpenChange}
              selectedPath={changePath}
            />
          )
          : (
            <WorkspaceTree
              nodes={tree}
              activePath={activePath}
              onOpen={onOpen}
              onToggle={onToggleDirectory}
            />
          )}
      </section>
    </div>
  );
}
