// The sidebar: which workspace, which section, and the section itself.
//
// The branch name used to ride the section nav and is on the IDE's status bar now. It says which
// repository every pane is showing, so it should not go away with the pane it was sitting in.

import type { Ref } from "react";
import type { WorkspaceGitStatus, WorkspaceSummary, WorkspaceTreeNode } from "@agentdesk/agent-feed-wire";
import { SearchPanel } from "@/features/workspace-ide/search/SearchPanel";
import type { ContentSearch } from "@/features/workspace-ide/search/useContentSearch";
import { SourceControl } from "@/features/workspace-ide/sidebar/SourceControl";
import { changedFileCount } from "@/features/workspace-ide/sidebar/gitTones";
import { SidebarSections } from "@/features/workspace-ide/sidebar/SidebarSections";
import { WorkspaceRoster } from "@/features/workspace-ide/sidebar/WorkspaceRoster";
import { WorkspaceTree } from "@/features/workspace-ide/sidebar/WorkspaceTree";
import type { TreeOrder } from "@/features/workspace-ide/sidebar/treeOrder";
import type { WorkspaceIdePreferences } from "@/features/workspace-ide/workspaceIdePreferences";

type Section = WorkspaceIdePreferences["section"];

export function WorkspaceSidebar({
  workspaces,
  workspaceId,
  section,
  tree,
  git,
  activePath,
  treeOrder,
  onSelectWorkspace,
  onSelectSection,
  onSelectTreeOrder,
  onAddWorkspace,
  onRenameWorkspace,
  onRemoveWorkspace,
  onReorderWorkspaces,
  onOpen,
  onOpenChange,
  changePath,
  onToggleDirectory,
  search,
  searchField,
  onOpenResult,
}: {
  workspaces: WorkspaceSummary[];
  workspaceId: string | null;
  section: Section;
  tree: WorkspaceTreeNode[];
  git: WorkspaceGitStatus | null;
  activePath: string | null;
  /** The order the tree's rows are in, which the Explorer section's control changes. */
  treeOrder: TreeOrder;
  onSelectWorkspace: (id: string) => void;
  onSelectSection: (section: Section) => void;
  onSelectTreeOrder: (order: TreeOrder) => void;
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
  /** The Search section's state, held above so its results outlive switching sections. */
  search: ContentSearch;
  /** The query field, so the shortcut that opens Search can put the caret in it. */
  searchField: Ref<HTMLInputElement>;
  onOpenResult: (path: string, line: number, start: number, end: number) => void;
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
        searchable
        // With the Explorer only, because the order is the tree's and there is no tree in the other
        // two sections. Source Control is sorted by how git resolves a change, which is not this.
        order={section === "explorer" ? treeOrder : undefined}
        onOrderChange={section === "explorer" ? onSelectTreeOrder : undefined}
        onSelect={onSelectSection}
      />

      {section === "search"
        ? (
          // Its own scroller, below a query box that stays put, so it is not inside the one below.
          <section className="min-h-0 flex-1 pt-1">
            <SearchPanel ref={searchField} search={search} onOpen={onOpenResult} />
          </section>
        )
        : null}
      <section
        hidden={section === "search"}
        className="min-h-0 flex-1 overflow-auto px-1 pb-4 pt-1"
      >
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
              order={treeOrder}
              onOpen={onOpen}
              onToggle={onToggleDirectory}
            />
          )}
      </section>
    </div>
  );
}
