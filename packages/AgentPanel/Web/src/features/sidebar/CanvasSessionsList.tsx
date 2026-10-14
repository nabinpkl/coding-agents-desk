// The Canvas tab's Sessions view: every session on this machine, grouped under its project or
// listed flat with the most recently changed first.
//
// The flat list is ordered by the sidecar, not here. It arrives on the inventory stream already cut
// and sorted (`RecentSessionsPayload`), and a session that changes moves to its top on the next
// catalog broadcast, so the panel holds one page of rows and sorts nothing. Nothing in it follows a
// session: a row subscribes to no thread, and picking one opens it in the modal, which is where
// its transcript stream opens.

import { FolderTree, Plus } from "lucide-react";
import { useMemo } from "react";
import type { ProjectSummary, RecentSessionsPayload, SessionSummary } from "@agentdesk/agent-feed-wire";
import { useSessionArchiveCommand } from "@/features/sidebar/ArchivedSessions";
import {
  ProjectSessionList,
  SessionRow,
  type SessionCanvasMove,
} from "@/features/sidebar/ProjectSidebarItem";
import { SidebarError, SidebarStatus } from "@/features/sidebar/SidebarStatusRows";

/** What the project list needs whichever list it sits in; the rest is this view's. */
type ProjectListProps = Omit<
  Parameters<typeof ProjectSessionList>[0],
  "selectedProjectPath" | "selectedSessionKey" | "onSelectSession" | "pi" | "canvasMove"
>;

export interface CanvasSessions {
  /** Opens a session in a modal over the canvas. */
  onOpen: (project: ProjectSummary, session: SessionSummary) => void;
  canvasMove: SessionCanvasMove;
  /** The session that modal is showing, so its row reads as the one picked. */
  modalSelection: { projectPath: string; sessionKey: string } | null;
  grouped: boolean;
  onGroupedChange: (grouped: boolean) => void;
  /** The flat list's current page, or null while it is grouped or has not arrived yet. */
  recent: RecentSessionsPayload | null;
  /** Asks the stream for the next page of the flat list. */
  onShowMore: () => void;
  /** Opens the dialog that starts a session on no Bot, in Claude Code or opencode. */
  onNewSession: () => void;
}

export function CanvasSessionsList({ list, sessions }: { list: ProjectListProps; sessions: CanvasSessions }) {
  return (
    <>
      <div className="flex justify-between gap-2 border-b border-border/80 px-2 py-1">
        <button
          type="button"
          onClick={sessions.onNewSession}
          aria-label="New session"
          title="New session"
          className="flex min-h-8 shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-md px-2 text-(length:--agent-panel-fs-sidebar-meta,13px) font-medium text-foreground outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-primary active:bg-muted/70"
        >
          <Plus className="size-4" aria-hidden />
          {/* "New" beside the list it adds to, so both controls fit one row at the rail's width. */}
          New
        </button>
        <button
          type="button"
          aria-pressed={sessions.grouped}
          onClick={() => sessions.onGroupedChange(!sessions.grouped)}
          className={`flex min-h-8 shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-md px-2 text-(length:--agent-panel-fs-sidebar-meta,13px) font-medium outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary active:bg-muted/70 ${
            sessions.grouped ? "text-foreground" : "text-muted-foreground"
          }`}
        >
          <FolderTree className="size-4" aria-hidden />
          Group by project
        </button>
      </div>
      {sessions.grouped ? (
        <ProjectSessionList
          {...list}
          selectedProjectPath={sessions.modalSelection?.projectPath ?? null}
          selectedSessionKey={sessions.modalSelection?.sessionKey ?? null}
          onSelectSession={sessions.onOpen}
          canvasMove={sessions.canvasMove}
        />
      ) : (
        <RecentSessionList list={list} sessions={sessions} />
      )}
    </>
  );
}

function RecentSessionList({ list, sessions }: { list: ProjectListProps; sessions: CanvasSessions }) {
  const archive = useSessionArchiveCommand(list.archiving?.setArchived);
  const projects = useMemo(
    () => new Map(list.projects.map((project) => [project.projectPath, project])),
    [list.projects],
  );

  if (list.error) return <SidebarError message={`Sessions unavailable: ${list.error}`} retrying={list.retrying} />;
  if (list.loading || !sessions.recent) return <SidebarStatus>Loading sessions…</SidebarStatus>;
  if (sessions.recent.recent.length === 0) return <SidebarStatus>No sessions yet</SidebarStatus>;

  return (
    <>
      <ul role="list" aria-label="Sessions, most recently changed first" className="pb-1">
        {sessions.recent.recent.map((row) => {
          // The project list and this cut come off one catalog snapshot, and the stream writes the
          // project list first, so a row's project is always known by the time the row is.
          const project = projects.get(row.projectPath);
          if (!project) return null;
          return (
            <SessionRow
              key={`${row.source}:${row.sessionId}`}
              session={row}
              selectedSessionKey={sessions.modalSelection?.sessionKey ?? null}
              onSelect={() => sessions.onOpen(project, row)}
              canvasMove={sessions.canvasMove}
              archive={list.archiving ? archive : undefined}
              project={project.displayName || row.projectPath}
            />
          );
        })}
      </ul>
      {sessions.recent.more ? (
        <button
          type="button"
          onClick={sessions.onShowMore}
          className="flex min-h-11 w-full cursor-pointer items-center px-3 text-left text-(length:--agent-panel-fs-sidebar-meta,13px) font-medium text-muted-foreground outline-none hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
        >
          Show more
        </button>
      ) : null}
    </>
  );
}
