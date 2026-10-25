"use client";

import { Archive, ChevronDown, FolderArchive, LayoutDashboard, LoaderCircle, Plus } from "lucide-react";
import { useId, useState } from "react";
import type { ProjectSummary, SessionSummary } from "@agentdesk/agent-feed-wire";
import { RowMenu, type RowMenuItem } from "@/features/bots/menus/RowMenu";
import {
  ArchivedSessions,
  ArchiveFailure,
  useSessionArchiveCommand,
  type SessionArchiving,
} from "@/features/sidebar/session-list/ArchivedSessions";
import {
  ArchivedProjects,
  projectDisplayName,
  useProjectArchiveCommand,
  type ProjectArchiveCommand,
} from "@/features/sidebar/session-list/ArchivedProjects";
import { ScratchProjects, scratchItemProject } from "@/features/sidebar/session-list/ScratchProjects";
import { SecurityReviewFold, splitSecurityReviews } from "@/features/sidebar/session-list/SecurityReviewSessions";
import { ActivityDot, SessionMeta } from "@/features/sidebar/session-list/SessionMeta";
import type { SessionFaces } from "@/features/bots/avatar/botSessionFaces";
import { BotSessionMark } from "@/features/bots/avatar/BotSessionMark";
import { SourceBadge } from "@/features/sidebar/SourceBadge";
import { InlineStatus, SidebarError, SidebarStatus } from "@/features/sidebar/SidebarStatusRows";

export type { SessionArchiving };

const INITIAL_SESSION_COUNT = 3;

/**
 * Moving a session onto the canvas from its row. Offered only by the Canvas tab's list, and only
 * on rows no Bot holds: a held session is on the canvas already, or one click from it in the roster.
 */
export interface SessionCanvasMove {
  /** `source:sessionId` of every session some Bot holds, on any machine. */
  held: ReadonlySet<string>;
  onMove: (session: SessionSummary) => void;
}
const SESSION_BATCH_SIZE = 10;

/**
 * What opens a row: a Bot's session wears its face, which rings green while it is live, and any
 * other session keeps the dot. In a list that shows faces the dot sits in a face-wide slot, so
 * every title starts at one edge.
 */
function SessionMark({ session, faces }: { session: SessionSummary; faces: SessionFaces | undefined }) {
  if (!faces) return <ActivityDot activity={session.activity} className="mt-1.5" />;
  const face = faces.get(`${session.source}:${session.sessionId}`);
  if (!face) {
    return (
      <span className="flex w-8 shrink-0 justify-center">
        <ActivityDot activity={session.activity} className="mt-1.5" />
      </span>
    );
  }
  return <BotSessionMark title={session.title || session.sessionId} activity={session.activity} face={face} />;
}

export function ProjectSidebarItem({
  project,
  sessions,
  expanded,
  active,
  selectedSessionKey,
  creating,
  creationError,
  onToggle,
  onSelectSession,
  onCreatePiSession,
  canvasMove,
  faces,
  archiving,
  projectArchive,
}: {
  project: ProjectSummary;
  sessions: SessionSummary[] | undefined;
  expanded: boolean;
  active: boolean;
  selectedSessionKey: string | null;
  creating: boolean;
  creationError: string | null;
  onToggle: () => void;
  onSelectSession: (session: SessionSummary) => void;
  /** Absent where a new Pi session is not offered, which is everywhere but the Sessions tab. */
  onCreatePiSession?: () => void;
  canvasMove?: SessionCanvasMove;
  faces?: SessionFaces;
  /** Archive and Unarchive. Absent where the list offers neither. */
  archiving?: SessionArchiving;
  /** The list's folder command, present where the list offers archiving a folder. */
  projectArchive?: ProjectArchiveCommand;
}) {
  const regionId = useId();
  const displayName = projectDisplayName(project);
  const projectMenu: RowMenuItem[] = projectArchive
    ? [
        {
          label: "Archive all sessions",
          icon: Archive,
          onSelect: () => projectArchive.run(project, "archive-sessions"),
        },
        { label: "Archive folder", icon: FolderArchive, onSelect: () => projectArchive.run(project, "archive") },
      ]
    : [];
  return (
    <li className="border-b border-border/80">
      <div className={active ? "bg-muted/45" : undefined}>
        <div className="flex min-h-11 items-stretch">
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={expanded}
            aria-controls={regionId}
            className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left hover:bg-muted/60"
          >
            <ChevronDown
              className={`size-4 shrink-0 text-muted-foreground transition-transform ${expanded ? "" : "-rotate-90"}`}
              aria-hidden
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-(length:--agent-panel-fs-sidebar-body,15px) font-medium">
                {displayName}
              </span>
              <span className="mt-0.5 flex items-center gap-1.5 text-(length:--agent-panel-fs-sidebar-meta,13px) text-muted-foreground">
                <span>
                  {project.sessionCount} {project.sessionCount === 1 ? "session" : "sessions"}
                </span>
                {Object.entries(project.sourceCounts)
                  .filter(([, count]) => count > 0)
                  .map(([source]) => (
                    <SourceBadge key={source} source={source} />
                  ))}
              </span>
            </span>
          </button>
          {expanded && onCreatePiSession ? (
            <button
              type="button"
              onClick={onCreatePiSession}
              disabled={creating}
              aria-label={`New Pi session in ${displayName}`}
              title="New Pi session"
              className="flex min-w-11 shrink-0 items-center justify-center gap-1 px-2 text-(length:--agent-panel-fs-sidebar-meta,13px) font-medium text-primary hover:bg-primary/10 disabled:opacity-50"
            >
              {creating ? (
                <LoaderCircle className="size-4 animate-spin" aria-hidden />
              ) : (
                <Plus className="size-4" aria-hidden />
              )}
              <span>Pi</span>
            </button>
          ) : null}
          {projectArchive?.isPending(project.projectPath) ? (
            <LoaderCircle
              className="mx-1 size-3.5 shrink-0 self-center text-muted-foreground motion-safe:animate-spin"
              role="img"
              aria-label="Archiving"
            />
          ) : null}
          {projectMenu.length > 0 ? (
            <span className="flex items-center pr-1">
              <RowMenu label={displayName} items={projectMenu} />
            </span>
          ) : null}
        </div>
        {projectArchive ? (
          <ArchiveFailure message={projectArchive.noticeFor(project.projectPath)} className="px-9 pb-2" />
        ) : null}
        {creationError ? (
          <p role="alert" className="px-9 pb-2 text-(length:--agent-panel-fs-sidebar-meta,13px) text-destructive">
            Pi session unavailable: {creationError}
          </p>
        ) : null}
      </div>
      {expanded ? (
        <div id={regionId} role="region" aria-label={`${displayName} sessions`}>
          <ProjectSessionPreview
            sessions={sessions}
            selectedSessionKey={selectedSessionKey}
            onSelect={onSelectSession}
            canvasMove={canvasMove}
            faces={faces}
            archiving={archiving}
          />
          {archiving ? (
            <ArchivedSessions
              archived={archiving.archivedByProject.get(project.projectPath)}
              setArchived={archiving.setArchived}
            />
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

export function ProjectSessionPreview({
  sessions,
  selectedSessionKey,
  onSelect,
  canvasMove,
  faces,
  archiving,
}: {
  sessions: SessionSummary[] | undefined;
  selectedSessionKey: string | null;
  onSelect: (session: SessionSummary) => void;
  canvasMove?: SessionCanvasMove | undefined;
  faces?: SessionFaces | undefined;
  archiving?: SessionArchiving | undefined;
}) {
  const archive = useSessionArchiveCommand(archiving?.setArchived);
  // How much of a long list is unfolded is this row's own business, and it lives and
  // dies with the row: collapsing a project unmounts this, so reopening it starts folded.
  const [visibleCount, setVisibleCount] = useState(INITIAL_SESSION_COUNT);
  const [reviewsOpen, setReviewsOpen] = useState(false);
  const [visibleReviews, setVisibleReviews] = useState(SESSION_BATCH_SIZE);

  // A failure has one home now, the inventory stream's, so there is no per-project
  // error state here: an unreachable sidecar is reported once at the top of the list
  // rather than once per expanded row.
  if (!sessions) return <InlineStatus>Loading sessions…</InlineStatus>;
  if (sessions.length === 0) return <InlineStatus>No sessions</InlineStatus>;

  const { sessions: own, reviews } = splitSecurityReviews(sessions);
  const row = (session: SessionSummary) => (
    <SessionRow
      key={`${session.source}:${session.sessionId}`}
      session={session}
      selectedSessionKey={selectedSessionKey}
      onSelect={() => onSelect(session)}
      canvasMove={canvasMove}
      faces={faces}
      archive={archiving ? archive : undefined}
    />
  );

  return (
    <>
      {own.length > 0 ? (
        <>
          <ul role="list" aria-label="Sessions" className="pb-1">
            {own.slice(0, visibleCount).map(row)}
          </ul>
          <ShowMore
            remaining={Math.max(0, own.length - visibleCount)}
            onShowMore={() => setVisibleCount((current) => current + SESSION_BATCH_SIZE)}
          />
        </>
      ) : null}
      <SecurityReviewFold
        count={reviews.length}
        live={reviews.filter((session) => session.activity === "live").length}
        open={reviewsOpen}
        onToggle={() => setReviewsOpen((current) => !current)}
        inset
      >
        <ul role="list" aria-label="Security reviews">
          {reviews.slice(0, visibleReviews).map(row)}
        </ul>
        <ShowMore
          remaining={Math.max(0, reviews.length - visibleReviews)}
          onShowMore={() => setVisibleReviews((current) => current + SESSION_BATCH_SIZE)}
        />
      </SecurityReviewFold>
    </>
  );
}

function ShowMore({ remaining, onShowMore }: { remaining: number; onShowMore: () => void }) {
  if (remaining === 0) return null;
  return (
    <button
      type="button"
      onClick={onShowMore}
      className="flex min-h-11 w-full items-center px-8 text-left text-(length:--agent-panel-fs-sidebar-meta,13px) font-medium text-muted-foreground hover:bg-muted/60 hover:text-foreground"
    >
      Show {Math.min(SESSION_BATCH_SIZE, remaining)} more ({remaining} remaining)
    </button>
  );
}

/**
 * One session's row, in a project's list or in the flat one.
 *
 * Shared so the two lists cannot drift: the same face or dot, meta, selection mark and row menu,
 * whichever way the reader chose to see their sessions. `project` names the session's project on a row that
 * is not already under it, which is every row of the flat list.
 */
export function SessionRow({
  session,
  selectedSessionKey,
  onSelect,
  canvasMove,
  faces,
  archive,
  project,
}: {
  session: SessionSummary;
  selectedSessionKey: string | null;
  onSelect: () => void;
  canvasMove?: SessionCanvasMove | undefined;
  faces?: SessionFaces | undefined;
  /** Archive, when the list offers it. One command per list, so its pending and failed rows are. */
  archive?: ReturnType<typeof useSessionArchiveCommand> | undefined;
  project?: string;
}) {
  const key = `${session.source}:${session.sessionId}`;
  const active = key === selectedSessionKey;
  const menu: RowMenuItem[] = [];
  if (canvasMove && !canvasMove.held.has(key)) {
    menu.push({ label: "Move to canvas", icon: LayoutDashboard, onSelect: () => canvasMove.onMove(session) });
  }
  if (archive) menu.push({ label: "Archive session", icon: Archive, onSelect: () => archive.run(session, true) });
  const failure = archive?.failureFor(session) ?? null;
  return (
    <li className={`flex flex-wrap items-center ${active ? "bg-muted" : ""}`}>
      <button
        type="button"
        onClick={onSelect}
        aria-current={active ? "page" : undefined}
        className={`flex min-h-11 min-w-0 flex-1 items-start gap-2 border-l-2 py-2 pr-3 text-left hover:bg-muted/60 ${
          project === undefined ? "pl-8" : "pl-3"
        } ${active ? "border-primary text-foreground" : "border-transparent"}`}
      >
        <SessionMark session={session} faces={faces} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-(length:--agent-panel-fs-sidebar-meta,13px) font-medium text-foreground">
            {session.title || session.sessionId}
          </span>
          <SessionMeta
            source={session.source}
            lastEventAt={session.lastEventAt}
            activity={session.activity}
            {...(project === undefined ? {} : { project })}
          />
        </span>
      </button>
      {archive?.isPending(session) ? (
        <LoaderCircle
          className="mr-2 size-3.5 shrink-0 text-muted-foreground motion-safe:animate-spin"
          role="img"
          aria-label="Archiving"
        />
      ) : null}
      {menu.length > 0 ? (
        <span className="pr-1">
          <RowMenu label={session.title || session.sessionId} items={menu} />
        </span>
      ) : null}
      {failure ? (
        <ArchiveFailure message={failure} className={`w-full pb-2 ${project === undefined ? "px-8" : "px-3"}`} />
      ) : null}
    </li>
  );
}

/**
 * Every project and, under each one the reader unfolded, its sessions.
 *
 * Shared by the Sessions tab and the Canvas tab's Sessions view, which differ only in what picking
 * a session does: the first opens it in the main column, the second in a modal over the canvas.
 */
export function ProjectSessionList(props: {
  projects: ProjectSummary[];
  sessionsByProject: ReadonlyMap<string, SessionSummary[]>;
  loading: boolean;
  error: string | null;
  retrying: boolean;
  selectedProjectPath: string | null;
  selectedSessionKey: string | null;
  expandedProjectPaths: ReadonlySet<string>;
  onToggleProject: (projectPath: string) => void;
  onSelectSession: (project: ProjectSummary, session: SessionSummary) => void;
  /** The Sessions tab's Pi controls; absent elsewhere. */
  pi?: {
    creatingProjectPath: string | null;
    creationErrors: ReadonlyMap<string, string>;
    onCreate: (project: ProjectSummary) => void;
  };
  /** The Canvas tab's row action; absent on the Sessions tab, whose sessions open in place. */
  canvasMove?: SessionCanvasMove;
  faces?: SessionFaces;
  archiving?: SessionArchiving;
}) {
  const projectArchiving = props.archiving?.projects;
  const projectArchive = useProjectArchiveCommand(projectArchiving);
  if (props.loading) return <SidebarStatus>Loading projects…</SidebarStatus>;
  if (props.error) {
    return <SidebarError message={`Projects unavailable: ${props.error}`} retrying={props.retrying} />;
  }
  const archivedFold = projectArchiving ? (
    <ArchivedProjects archiving={projectArchiving} command={projectArchive} />
  ) : null;
  if (props.projects.length === 0) {
    return (
      <>
        <SidebarStatus>No projects yet</SidebarStatus>
        {archivedFold}
      </>
    );
  }
  const scratch = props.projects.filter((project) => project.scratch);
  const item = (project: ProjectSummary, listedAs: ProjectSummary = project) => (
    <ProjectSidebarItem
      key={project.projectPath}
      project={listedAs}
      sessions={props.sessionsByProject.get(project.projectPath)}
      expanded={props.expandedProjectPaths.has(project.projectPath)}
      active={props.selectedProjectPath === project.projectPath}
      selectedSessionKey={props.selectedProjectPath === project.projectPath ? props.selectedSessionKey : null}
      creating={props.pi?.creatingProjectPath === project.projectPath}
      creationError={props.pi?.creationErrors.get(project.projectPath) ?? null}
      onToggle={() => props.onToggleProject(project.projectPath)}
      onSelectSession={(session) => props.onSelectSession(project, session)}
      {...(props.pi ? { onCreatePiSession: () => props.pi!.onCreate(project) } : {})}
      {...(props.canvasMove ? { canvasMove: props.canvasMove } : {})}
      {...(props.faces ? { faces: props.faces } : {})}
      {...(props.archiving ? { archiving: props.archiving } : {})}
      {...(projectArchiving ? { projectArchive } : {})}
    />
  );
  return (
    <>
      <ul role="list" aria-label="Projects">
        {props.projects.filter((project) => !project.scratch).map((project) => item(project))}
      </ul>
      <ScratchProjects count={scratch.length}>
        {scratch.map((project) => item(project, scratchItemProject(project)))}
      </ScratchProjects>
      {archivedFold}
    </>
  );
}
