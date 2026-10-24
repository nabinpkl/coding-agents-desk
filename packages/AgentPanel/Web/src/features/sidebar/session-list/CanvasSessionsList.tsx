// The Canvas tab's Sessions view: every machine's sessions, grouped under their projects or
// listed flat with the most recently changed first, and searched by title.
//
// Grouped, each machine is a section of its own projects, because a project is a directory on one
// machine. Flat, the machines are one list (`mergeRecentSessions`), and a row from another machine
// names it beside its project. A row opens, moves and archives on the machine it came from.
//
// A search is answered by the sidecar over the whole catalog, not by filtering the rows held here:
// the flat list holds one page, and a filter over that page would miss every older session
// without saying so. While a search is showing, the list is the flat one whichever way the view is
// set, because the grouped view holds only the projects that are expanded.
//
// The flat list is ordered by the sidecar, not here. It arrives on the inventory stream already cut
// and sorted (`RecentSessionsPayload`), and a session that changes moves to its top on the next
// catalog broadcast, so the panel holds one page of rows and sorts nothing. Nothing in it follows a
// session: a row subscribes to no thread, and picking one opens it in the modal, which is where
// its transcript stream opens.

import { FolderTree, MessageSquare, Plus, Search, X } from "lucide-react";
import { useId, useMemo, type ReactNode } from "react";
import type { ProjectSummary, RecentSession, RecentSessionsPayload, SessionSummary } from "@agentdesk/agent-feed-wire";
import { useSessionArchiveCommand } from "@/features/sidebar/session-list/ArchivedSessions";
import { SecurityReviewFold } from "@/features/sidebar/session-list/SecurityReviewSessions";
import {
  ProjectSessionList,
  SessionRow,
  type SessionCanvasMove,
} from "@/features/sidebar/session-list/ProjectSidebarItem";
import { SidebarError, SidebarReconnecting, SidebarStatus } from "@/features/sidebar/SidebarStatusRows";
import { RowMenu } from "@/features/bots/menus/RowMenu";
import type { SessionFaces } from "@/features/bots/avatar/botSessionFaces";

/** What the project list needs whichever list it sits in; the rest is this view's. */
type ProjectListProps = Omit<
  Parameters<typeof ProjectSessionList>[0],
  "selectedProjectPath" | "selectedSessionKey" | "onSelectSession" | "pi" | "canvasMove" | "faces"
>;

/** Another machine's sessions, listed beside the ones of the machine the shell is pointed at. */
export interface MachineSessions {
  /** The machine's key (`machineKey`), which a row of it hands back when it is opened. */
  key: string;
  label: string;
  list: ProjectListProps;
}

export interface CanvasSessions {
  /** Opens a session in a modal over the canvas; `machine` names another machine's row. */
  onOpen: (project: ProjectSummary, session: SessionSummary, machine?: string) => void;
  canvasMove: SessionCanvasMove;
  /** The face each Bot's session wears, so its row reads as the session on that Bot's card. */
  faces: SessionFaces;
  /** The session that modal is showing, so its row reads as the one picked. */
  modalSelection: { projectPath: string; sessionKey: string; machine?: string } | null;
  grouped: boolean;
  onGroupedChange: (grouped: boolean) => void;
  /** The flat list's current page, every machine's, or null while it is grouped or has not arrived. */
  recent: RecentSessionsPayload | null;
  /** Which other machine each of those rows is from, by `source:sessionId`. */
  recentMachines: ReadonlyMap<string, string>;
  /** The machine the shell is pointed at, which names its section when there are others. */
  home: string;
  /** Every other machine, in the canvas's order; empty when there is one. */
  peers: readonly MachineSessions[];
  /** Asks the stream for the next page of the flat list. */
  onShowMore: () => void;
  /**
   * The title search. `query` is what the field shows; `active` is that the flat list is the
   * answer to it, which it becomes once typing pauses, so the list does not change per letter.
   */
  search: { query: string; onQueryChange: (query: string) => void; active: boolean };
  /** The stream dropped after delivering; the list shown is the last one it sent. */
  reconnecting: boolean;
  /**
   * The flat list's security reviews, held out of it by the sidecar and folded into one row at
   * its bottom. Opening the row is what asks the stream for them, so it is the inventory's state.
   */
  reviews: { open: boolean; onToggle: () => void; onShowMore: () => void };
  /** Opens the dialog that starts a session on no Bot, in Claude Code or opencode. */
  onNewSession: () => void;
  /** Opens the Chat box, which starts a chat with no project once its first message is sent. */
  onNewChat: () => void;
}

export function CanvasSessionsList({ list, sessions }: { list: ProjectListProps; sessions: CanvasSessions }) {
  return (
    <>
      <div className="flex items-center gap-0.5 border-b border-border/80 px-2 py-1">
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
        <RowMenu label="new sessions" items={[{ label: "Chat", icon: MessageSquare, onSelect: sessions.onNewChat }]} />
        <span className="flex-1" />
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
      <SessionSearchField search={sessions.search} />
      {sessions.reconnecting ? <SidebarReconnecting /> : null}
      {sessions.grouped && !sessions.search.active ? (
        <GroupedSessionList list={list} sessions={sessions} />
      ) : (
        <RecentSessionList list={list} sessions={sessions} />
      )}
    </>
  );
}

/** Each machine's projects, under its name once there is more than one machine. */
function GroupedSessionList({ list, sessions }: { list: ProjectListProps; sessions: CanvasSessions }) {
  const machineList = (machine: string | undefined, of: ProjectListProps) => {
    const selection = sessions.modalSelection?.machine === machine ? sessions.modalSelection : null;
    return (
      <ProjectSessionList
        {...of}
        selectedProjectPath={selection?.projectPath ?? null}
        selectedSessionKey={selection?.sessionKey ?? null}
        onSelectSession={(project, session) =>
          machine === undefined ? sessions.onOpen(project, session) : sessions.onOpen(project, session, machine)
        }
        canvasMove={sessions.canvasMove}
        faces={sessions.faces}
      />
    );
  };
  if (sessions.peers.length === 0) return machineList(undefined, list);
  return (
    <>
      <MachineSection label={sessions.home}>{machineList(undefined, list)}</MachineSection>
      {sessions.peers.map((peer) => (
        <MachineSection key={peer.key} label={peer.label}>
          {machineList(peer.key, peer.list)}
        </MachineSection>
      ))}
    </>
  );
}

function MachineSection({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="border-b border-border/80 last:border-b-0">
      <h3
        id={id}
        className="border-b border-border/80 bg-muted/40 px-3 py-1.5 text-(length:--agent-panel-fs-sidebar-meta,13px) font-semibold text-muted-foreground"
      >
        {label}
      </h3>
      {children}
    </section>
  );
}

function RecentSessionList({ list, sessions }: { list: ProjectListProps; sessions: CanvasSessions }) {
  const peerOf = (session: SessionSummary) => {
    const key = sessions.recentMachines.get(`${session.source}:${session.sessionId}`);
    return key === undefined ? undefined : sessions.peers.find((peer) => peer.key === key);
  };
  // One command for the list, so its pending and failed rows are one, sent to the row's machine.
  const homeArchiving = list.archiving;
  const archive = useSessionArchiveCommand(
    homeArchiving
      ? (session, archived) => {
          const peer = peerOf(session);
          const archiving = peer ? peer.list.archiving : homeArchiving;
          if (!archiving) return Promise.reject(new Error("that machine's list offers no archiving"));
          return archiving.setArchived(session, archived);
        }
      : undefined,
  );
  // By machine key, and the shell's own under `undefined`: the Mac's key is the empty string, and it
  // is a peer whenever the tab bar points the shell at another machine.
  const projects = useMemo(
    () =>
      new Map(
        [{ key: undefined as string | undefined, list }, ...sessions.peers].map((machine) => [
          machine.key,
          new Map(machine.list.projects.map((project) => [project.projectPath, project])),
        ]),
      ),
    [list, sessions.peers],
  );
  // A machine that never answered says so here; one that answered and dropped is the chip's.
  const unreachable = sessions.peers
    .filter((peer) => peer.list.error)
    .map((peer) => (
      <SidebarError
        key={peer.key}
        message={`${peer.label}: sessions unavailable: ${peer.list.error}`}
        retrying={peer.list.retrying}
      />
    ));

  if (list.error) return <SidebarError message={`Sessions unavailable: ${list.error}`} retrying={list.retrying} />;
  if (list.loading || !sessions.recent) return <SidebarStatus>Loading sessions…</SidebarStatus>;
  const { recent, securityReviews } = sessions.recent;
  const searched = sessions.search.active ? sessions.search.query.trim() : "";
  if (recent.length === 0 && securityReviews.count === 0) {
    return (
      <>
        {unreachable}
        <SidebarStatus>{searched ? `No session titled “${searched}”` : "No sessions yet"}</SidebarStatus>
      </>
    );
  }

  const row = (session: RecentSession) => {
    // The project list and this cut come off one catalog snapshot, and the stream writes the
    // project list first, so a row's project is always known by the time the row is. Each
    // machine's stream does, so a row's project is looked up on its own machine.
    const peer = peerOf(session);
    const project = projects.get(peer?.key)?.get(session.projectPath);
    if (!project) return null;
    const projectName = project.displayName || session.projectPath;
    return (
      <SessionRow
        key={`${session.source}:${session.sessionId}`}
        session={session}
        selectedSessionKey={sessions.modalSelection?.sessionKey ?? null}
        onSelect={() => (peer ? sessions.onOpen(project, session, peer.key) : sessions.onOpen(project, session))}
        canvasMove={sessions.canvasMove}
        faces={sessions.faces}
        archive={list.archiving ? archive : undefined}
        project={peer ? `${peer.label} · ${projectName}` : projectName}
      />
    );
  };

  return (
    <>
      {unreachable}
      <ul
        role="list"
        aria-label={
          searched
            ? `Sessions titled “${searched}”, most recently changed first`
            : "Sessions, most recently changed first"
        }
        className="pb-1"
      >
        {recent.map(row)}
      </ul>
      {sessions.recent.more ? <ShowMore onClick={sessions.onShowMore} /> : null}
      <SecurityReviewFold
        count={securityReviews.count}
        live={securityReviews.live}
        open={sessions.reviews.open}
        onToggle={sessions.reviews.onToggle}
        inset={false}
      >
        {/* Empty for the moment between opening the row and the stream answering for it. */}
        {securityReviews.recent.length === 0 ? (
          <SidebarStatus>Loading security reviews…</SidebarStatus>
        ) : (
          <ul role="list" aria-label="Security reviews, most recently changed first">
            {securityReviews.recent.map(row)}
          </ul>
        )}
        {securityReviews.more && securityReviews.recent.length > 0 ? (
          <ShowMore onClick={sessions.reviews.onShowMore} />
        ) : null}
      </SecurityReviewFold>
    </>
  );
}

function SessionSearchField({ search }: { search: CanvasSessions["search"] }) {
  const id = useId();
  return (
    <div className="flex items-center gap-2 border-b border-border/80 pl-3 pr-1 transition-colors focus-within:bg-muted/40">
      <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <label className="sr-only" htmlFor={id}>
        Search sessions by title
      </label>
      <input
        id={id}
        type="search"
        value={search.query}
        onChange={(event) => search.onQueryChange(event.target.value)}
        onKeyDown={(event) => {
          // Escape empties the field before it does anything else, the way a browser's own find bar
          // does; on an empty field it is left to whatever holds the sidebar.
          if (event.key !== "Escape" || search.query === "") return;
          event.preventDefault();
          event.stopPropagation();
          search.onQueryChange("");
        }}
        placeholder="Search titles"
        autoComplete="off"
        spellCheck={false}
        enterKeyHint="search"
        className="min-h-10 w-full min-w-0 bg-transparent text-(length:--agent-panel-fs-sidebar-body,15px) outline-none placeholder:text-muted-foreground [&::-webkit-search-cancel-button]:hidden"
      />
      {/* Its slot is the field's height either way, so the row does not move when it appears. */}
      {search.query !== "" ? (
        <button
          type="button"
          onClick={() => search.onQueryChange("")}
          aria-label="Clear search"
          title="Clear search"
          className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary active:bg-muted/70"
        >
          <X className="size-4" aria-hidden />
        </button>
      ) : null}
    </div>
  );
}

function ShowMore({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-h-11 w-full cursor-pointer items-center px-3 text-left text-(length:--agent-panel-fs-sidebar-meta,13px) font-medium text-muted-foreground outline-none hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
    >
      Show more
    </button>
  );
}
