// The sidebar: which workspace, which section, and the section itself.

import { FolderTree, GitBranch } from "lucide-react";
import type { WorkspaceGitStatus, WorkspaceSummary, WorkspaceTreeNode } from "@agentdesk/agent-feed-wire";
import { SourceControl } from "@/features/workspace-ide/sidebar/SourceControl";
import { changedFileCount } from "@/features/workspace-ide/sidebar/gitTones";
import { WorkspaceRoster } from "@/features/workspace-ide/sidebar/WorkspaceRoster";
import { WorkspaceTree } from "@/features/workspace-ide/sidebar/WorkspaceTree";
import type { WorkspaceIdePreferences } from "@/features/workspace-ide/workspaceIdePreferences";

type Section = WorkspaceIdePreferences["section"];

function changedLabel(count: number): string {
  return `${count} changed ${count === 1 ? "file" : "files"}`;
}

const SECTIONS: { id: Section; label: string; Icon: typeof FolderTree }[] = [
  { id: "explorer", label: "Explorer", Icon: FolderTree },
  { id: "sourceControl", label: "Source Control", Icon: GitBranch },
];

const CONTROL = "relative grid h-7 w-8 place-items-center rounded-md outline-none transition-colors"
  + " focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset";

/**
 * The count rides the tab, so the number of changed files is readable from the Explorer.
 *
 * Filled rather than tinted, unlike the per-section counts inside Source Control: those label a
 * group the reader is already looking at, and this one has to be seen from the other section.
 */
const BADGE = "pointer-events-none absolute -bottom-0.5 -right-0.5 min-w-[14px] rounded-full"
  + " bg-primary px-1 text-center font-mono text-[9px] leading-[14px] text-primary-foreground";

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

      <nav
        aria-label="Workspace sidebar sections"
        className="flex shrink-0 items-center gap-1 border-b border-border px-1.5 py-1"
      >
        {SECTIONS.map(({ id, label, Icon }) => {
          const selected = id === section;
          const count = id === "sourceControl" ? changed : 0;
          return (
            <button
              key={id}
              type="button"
              // The name is gone from the pixels but not from the surface: the label carries it to
              // a screen reader and the title brings it back on hover. The count goes in both,
              // because the badge that carries it is a glyph to everything but the eye.
              aria-label={count > 0 ? `Show ${label}, ${changedLabel(count)}` : `Show ${label}`}
              aria-pressed={selected}
              title={count > 0 ? `${label} (${changedLabel(count)})` : label}
              onClick={() => onSelectSection(id)}
              className={`${CONTROL} ${selected
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"}`}
            >
              <Icon className="size-4" />
              {/* Capped, because the badge sits on a 32px button and a four-digit count would
                  cover the glyph it is annotating. */}
              {count > 0
                ? <span aria-hidden className={BADGE}>{count > 99 ? "99+" : count}</span>
                : null}
            </button>
          );
        })}
        {git?.branch
          ? (
            <span className="ml-auto min-w-0 overflow-hidden text-ellipsis whitespace-nowrap
              px-1 text-[11px] text-muted-foreground"
            >
              {git.branch}
            </span>
          )
          : null}
      </nav>

      <section className="min-h-0 flex-1 overflow-auto px-1 pb-4 pt-1">
        {section === "sourceControl"
          ? <SourceControl entries={git?.entries ?? []} onOpen={onOpen} />
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
