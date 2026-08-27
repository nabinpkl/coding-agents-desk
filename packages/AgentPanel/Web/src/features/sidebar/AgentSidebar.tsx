import {
  ChevronDown,
  LoaderCircle,
  Plus,
  X,
} from "lucide-react";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react";
import type { BotSessionRef, BotView, ProjectSummary, SessionSummary } from "@agentdesk/agent-feed-wire";
import { ProfileRow } from "../profile/ProfileRow";
import { BotSidebarPanel } from "../bots/BotSidebarPanel";
import type { DesktopParkHandle } from "../desktop-park/useDesktopPark";
import type { UsageHandle } from "../usage/useUsage";
import { SourceBadge } from "./SourceBadge";

const INITIAL_SESSION_COUNT = 3;
const SESSION_BATCH_SIZE = 10;

export type AgentSidebarMode = "sessions" | "bots";

interface AgentSidebarProps {
  mode: AgentSidebarMode;
  onModeChange: (mode: AgentSidebarMode) => void;
  projects: ProjectSummary[];
  /**
   * Sessions for every expanded project, or no entry for one whose list has not
   * arrived yet.
   *
   * Passed in rather than fetched here: the projects and all their sessions ride one
   * stream, and a component that opened a subscription per expanded row is what made
   * the number of open connections a function of how much of the tree the reader had
   * unfolded.
   */
  sessionsByProject: ReadonlyMap<string, SessionSummary[]>;
  loading: boolean;
  error: string | null;
  retrying: boolean;
  selectedProjectPath: string | null;
  selectedSessionKey: string | null;
  creatingProjectPath: string | null;
  creationErrors: ReadonlyMap<string, string>;
  expandedProjectPaths: ReadonlySet<string>;
  onToggleProject: (projectPath: string) => void;
  onSelectSession: (project: ProjectSummary, session: SessionSummary) => void;
  onCreatePiSession: (project: ProjectSummary) => void;
  bots: BotView[];
  botsLoading: boolean;
  botsError: string | null;
  selectedBotId: string | null;
  onSelectBotSession: (bot: BotView, session: SessionSummary) => void;
  onAddBotSession: (bot: BotView) => void;
  onDetachBotSession: (bot: BotView, session: BotSessionRef) => void;
  onAddBot: () => void;
  onClose?: () => void;
  ownsWindowTitlebar?: boolean;
  /** Drives the Profile section's Usage entry. Owned by the app, so all three sidebar mounts
   *  share one subscription rather than opening one each. */
  usage: UsageHandle;
  park: DesktopParkHandle;
}

export function AgentSidebar(props: AgentSidebarProps) {
  const sessionsTabId = useId();
  const sessionsPanelId = useId();
  const botsTabId = useId();
  const botsPanelId = useId();
  const sessionsTabRef = useRef<HTMLButtonElement>(null);
  const botsTabRef = useRef<HTMLButtonElement>(null);

  const selectMode = (mode: AgentSidebarMode, focus = false) => {
    props.onModeChange(mode);
    if (focus) {
      const target = mode === "sessions" ? sessionsTabRef : botsTabRef;
      globalThis.requestAnimationFrame?.(() => target.current?.focus());
    }
  };

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    let next: AgentSidebarMode | null = null;
    if (event.key === "ArrowLeft" || event.key === "Home") next = "sessions";
    else if (event.key === "ArrowRight" || event.key === "End") next = "bots";
    if (next === null) return;
    event.preventDefault();
    selectMode(next, true);
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-card text-foreground">
      <div
        data-window-drag
        className={`flex min-h-11 shrink-0 items-center border-b border-border px-1.5${
          props.ownsWindowTitlebar ? " agent-window-titlebar-sidebar-leading" : ""
        }`}
      >
        <div role="tablist" aria-label="Agent views" className="flex min-w-0 flex-1 self-stretch">
          <button
            ref={sessionsTabRef}
            id={sessionsTabId}
            type="button"
            role="tab"
            aria-selected={props.mode === "sessions"}
            aria-controls={sessionsPanelId}
            tabIndex={props.mode === "sessions" ? 0 : -1}
            onClick={() => selectMode("sessions")}
            onKeyDown={handleTabKeyDown}
            className={`flex min-h-11 items-center border-b-2 px-2 text-(length:--agent-panel-fs-sidebar-title,15px) font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset active:bg-muted/70 ${
              props.mode === "sessions"
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:bg-muted/60 hover:text-foreground"
            }`}
          >
            Sessions
          </button>
          <button
            ref={botsTabRef}
            id={botsTabId}
            type="button"
            role="tab"
            aria-selected={props.mode === "bots"}
            aria-controls={botsPanelId}
            tabIndex={props.mode === "bots" ? 0 : -1}
            onClick={() => selectMode("bots")}
            onKeyDown={handleTabKeyDown}
            className={`flex min-h-11 items-center border-b-2 px-2 text-(length:--agent-panel-fs-sidebar-title,15px) font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset active:bg-muted/70 ${
              props.mode === "bots"
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:bg-muted/60 hover:text-foreground"
            }`}
          >
            Bots
          </button>
        </div>
        {props.onClose ? (
          <button
            type="button"
            onClick={props.onClose}
            aria-label="Close agent navigation"
            className="flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary active:bg-muted/70"
          >
            <X className="size-5" aria-hidden />
          </button>
        ) : null}
      </div>

      {/* The bottom safe area is no longer spent here. It moved to the Profile row below, which is
          now what touches the home indicator; leaving it on the scroller would hold back a strip
          under a row that is already clear of it. */}
      {props.mode === "sessions" ? (
        <div
          id={sessionsPanelId}
          role="tabpanel"
          aria-labelledby={sessionsTabId}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
        >
          {props.loading ? (
            <SidebarStatus>Loading projects…</SidebarStatus>
          ) : props.error ? (
            <SidebarError message={`Projects unavailable: ${props.error}`} retrying={props.retrying} />
          ) : props.projects.length === 0 ? (
            <SidebarStatus>No projects yet</SidebarStatus>
          ) : (
            <ul role="list" aria-label="Projects">
              {props.projects.map((project) => (
                <ProjectSidebarItem
                  key={project.projectPath}
                  project={project}
                  sessions={props.sessionsByProject.get(project.projectPath)}
                  expanded={props.expandedProjectPaths.has(project.projectPath)}
                  active={props.selectedProjectPath === project.projectPath}
                  selectedSessionKey={
                    props.selectedProjectPath === project.projectPath
                      ? props.selectedSessionKey
                      : null
                  }
                  creating={props.creatingProjectPath === project.projectPath}
                  creationError={props.creationErrors.get(project.projectPath) ?? null}
                  onToggle={() => props.onToggleProject(project.projectPath)}
                  onSelectSession={(session) => props.onSelectSession(project, session)}
                  onCreatePiSession={() => props.onCreatePiSession(project)}
                />
              ))}
            </ul>
          )}
        </div>
      ) : (
        <div
          id={botsPanelId}
          role="tabpanel"
          aria-labelledby={botsTabId}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
        >
          <BotSidebarPanel
            bots={props.bots}
            loading={props.botsLoading}
            error={props.botsError}
            selectedBotId={props.selectedBotId}
            selectedSessionKey={props.selectedSessionKey}
            onSelectSession={props.onSelectBotSession}
            onAddSession={props.onAddBotSession}
            onDetachSession={props.onDetachBotSession}
            onAddBot={props.onAddBot}
          />
        </div>
      )}

      <ProfileRow usage={props.usage} park={props.park} />
    </div>
  );
}

interface AgentSidebarDialogProps extends AgentSidebarProps {
  open: boolean;
  triggerRef: RefObject<HTMLButtonElement | null>;
  onRequestClose: () => void;
}

export function AgentSidebarDialog({
  open,
  triggerRef,
  onRequestClose,
  ...sidebarProps
}: AgentSidebarDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
    } else if (!open && dialog.open) {
      if (typeof dialog.close === "function") dialog.close();
      else {
        dialog.removeAttribute("open");
        dialog.dispatchEvent(new Event("close"));
      }
    }
  }, [open]);

  const closeDialog = () => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (typeof dialog.close === "function") dialog.close();
    else {
      dialog.removeAttribute("open");
      dialog.dispatchEvent(new Event("close"));
    }
  };

  const closeAndRestoreFocus = () => {
    onRequestClose();
    globalThis.requestAnimationFrame?.(() => triggerRef.current?.focus());
  };

  // The drawer is the compact-layout agent navigation, so it only ever renders on the phone,
  // where it is also the one surface the app shell's safe-area padding cannot reach: `showModal`
  // puts it in the top layer, a sibling of the tree that pays for the edges. It sits against the
  // leading edge, so it pays for that one itself; the bottom is paid inside, by the scroller, so
  // the list can still be scrolled through the strip the home indicator sits on.
  return (
    <dialog
      ref={dialogRef}
      aria-label="Agent navigation"
      className="agent-sidebar-dialog fixed inset-y-0 left-0 m-0 h-dvh max-h-none w-[min(88vw,320px)] max-w-none border-0 border-r border-border bg-card p-0 pl-[env(safe-area-inset-left)] text-foreground shadow-2xl"
      onClose={closeAndRestoreFocus}
      onCancel={(event) => {
        event.preventDefault();
        closeDialog();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) closeDialog();
      }}
    >
      <AgentSidebar
        {...sidebarProps}
        onClose={closeDialog}
        ownsWindowTitlebar
      />
    </dialog>
  );
}

function ProjectSidebarItem({
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
  onCreatePiSession: () => void;
}) {
  const regionId = useId();
  const displayName = project.displayName || project.projectPath.split("/").pop() || project.projectPath;
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
                <span>{project.sessionCount} {project.sessionCount === 1 ? "session" : "sessions"}</span>
                {Object.entries(project.sourceCounts)
                  .filter(([, count]) => count > 0)
                  .map(([source]) => <SourceBadge key={source} source={source} />)}
              </span>
            </span>
          </button>
          {expanded ? (
            <button
              type="button"
              onClick={onCreatePiSession}
              disabled={creating}
              aria-label={`New Pi session in ${displayName}`}
              title="New Pi session"
              className="flex min-w-11 shrink-0 items-center justify-center gap-1 px-2 text-(length:--agent-panel-fs-sidebar-meta,13px) font-medium text-primary hover:bg-primary/10 disabled:opacity-50"
            >
              {creating ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : <Plus className="size-4" aria-hidden />}
              <span>Pi</span>
            </button>
          ) : null}
        </div>
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
          />
        </div>
      ) : null}
    </li>
  );
}

function ProjectSessionPreview({
  sessions,
  selectedSessionKey,
  onSelect,
}: {
  sessions: SessionSummary[] | undefined;
  selectedSessionKey: string | null;
  onSelect: (session: SessionSummary) => void;
}) {
  // How much of a long list is unfolded is this row's own business, and it lives and
  // dies with the row: collapsing a project unmounts this, so reopening it starts folded.
  const [visibleCount, setVisibleCount] = useState(INITIAL_SESSION_COUNT);

  // A failure has one home now, the inventory stream's, so there is no per-project
  // error state here: an unreachable sidecar is reported once at the top of the list
  // rather than once per expanded row.
  if (!sessions) return <InlineStatus>Loading sessions…</InlineStatus>;
  if (sessions.length === 0) return <InlineStatus>No sessions</InlineStatus>;

  const visibleSessions = sessions.slice(0, visibleCount);
  const remaining = Math.max(0, sessions.length - visibleSessions.length);
  const nextBatch = Math.min(SESSION_BATCH_SIZE, remaining);

  return (
    <>
      <ul role="list" aria-label="Sessions" className="pb-1">
        {visibleSessions.map((session) => {
          const key = `${session.source}:${session.sessionId}`;
          const active = key === selectedSessionKey;
          const time = new Date(session.lastEventAt).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          });
          return (
            <li key={key}>
              <button
                type="button"
                onClick={() => onSelect(session)}
                aria-current={active ? "page" : undefined}
                className={`flex min-h-11 w-full items-start gap-2 border-l-2 py-2 pr-3 pl-8 text-left hover:bg-muted/60 ${
                  active ? "border-primary bg-muted text-foreground" : "border-transparent"
                }`}
              >
                <span
                  className={`mt-1.5 size-2 shrink-0 rounded-full ${session.activity === "live" ? "bg-green-500" : "bg-muted-foreground/35"}`}
                  aria-hidden
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-(length:--agent-panel-fs-sidebar-meta,13px) font-medium text-foreground">
                    {session.title || session.sessionId}
                  </span>
                  <span className="mt-0.5 flex items-center gap-1.5 text-(length:--agent-panel-fs-sidebar-chip,11px) text-muted-foreground">
                    <SourceBadge source={session.source} />
                    <span>{time}</span>
                    <span className="capitalize">{session.activity}</span>
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {remaining > 0 ? (
        <button
          type="button"
          onClick={() => setVisibleCount((current) => current + SESSION_BATCH_SIZE)}
          className="flex min-h-11 w-full items-center px-8 text-left text-(length:--agent-panel-fs-sidebar-meta,13px) font-medium text-muted-foreground hover:bg-muted/60 hover:text-foreground"
        >
          Show {nextBatch} more ({remaining} remaining)
        </button>
      ) : null}
    </>
  );
}

function SidebarStatus({ children }: { children: string }) {
  return (
    <div role="status" className="flex min-h-28 items-center justify-center p-4 text-center text-(length:--agent-panel-fs-sidebar-meta,13px) text-muted-foreground">
      {children}
    </div>
  );
}

function InlineStatus({ children }: { children: string }) {
  return (
    <div role="status" className="px-8 py-3 text-(length:--agent-panel-fs-sidebar-meta,13px) text-muted-foreground">
      {children}
    </div>
  );
}

function SidebarError({
  message,
  retrying,
}: {
  message: string;
  retrying: boolean;
}) {
  return (
    <div role="alert" className="p-4 text-(length:--agent-panel-fs-sidebar-meta,13px)">
      <p className="text-destructive">{message}</p>
      {retrying ? (
        <span className="mt-1 flex items-center gap-1.5 text-muted-foreground">
          <LoaderCircle className="size-3 animate-spin" aria-hidden />
          Retrying…
        </span>
      ) : null}
    </div>
  );
}
