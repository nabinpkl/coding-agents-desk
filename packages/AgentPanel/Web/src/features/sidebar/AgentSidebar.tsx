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
  type RefObject,
} from "react";
import type {
  BridgeDataSource,
  BridgeProject,
  BridgeSessionSummary,
} from "../activity-feed/data-source/BridgeDataSource";

const INITIAL_SESSION_COUNT = 3;
const SESSION_BATCH_SIZE = 10;

function retryDelayMs(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 15000);
}

interface AgentSidebarProps {
  bridge: BridgeDataSource;
  projects: BridgeProject[];
  loading: boolean;
  error: string | null;
  retrying: boolean;
  selectedProjectPath: string | null;
  selectedSessionKey: string | null;
  creatingProjectPath: string | null;
  creationErrors: ReadonlyMap<string, string>;
  expandedProjectPaths: ReadonlySet<string>;
  onToggleProject: (projectPath: string) => void;
  onSelectSession: (project: BridgeProject, session: BridgeSessionSummary) => void;
  onCreatePiSession: (project: BridgeProject) => void;
  onClose?: () => void;
  ownsWindowTitlebar?: boolean;
}

export function AgentSidebar(props: AgentSidebarProps) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-card text-foreground">
      <div
        data-window-drag
        className={`flex min-h-11 shrink-0 items-center border-b border-border px-3${
          props.ownsWindowTitlebar ? " agent-window-titlebar-sidebar-leading" : ""
        }`}
      >
        <h2 className="min-w-0 flex-1 truncate text-(length:--agent-panel-fs-sidebar-title,15px) font-semibold">
          Projects
        </h2>
        {props.onClose ? (
          <button
            type="button"
            onClick={props.onClose}
            aria-label="Close projects"
            className="flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="size-5" aria-hidden />
          </button>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
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
                bridge={props.bridge}
                project={project}
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

  return (
    <dialog
      ref={dialogRef}
      aria-label="Projects"
      className="agent-sidebar-dialog fixed inset-y-0 left-0 m-0 h-dvh max-h-none w-[min(88vw,320px)] max-w-none border-0 border-r border-border bg-card p-0 text-foreground shadow-2xl"
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
  bridge,
  project,
  expanded,
  active,
  selectedSessionKey,
  creating,
  creationError,
  onToggle,
  onSelectSession,
  onCreatePiSession,
}: {
  bridge: BridgeDataSource;
  project: BridgeProject;
  expanded: boolean;
  active: boolean;
  selectedSessionKey: string | null;
  creating: boolean;
  creationError: string | null;
  onToggle: () => void;
  onSelectSession: (session: BridgeSessionSummary) => void;
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
            bridge={bridge}
            projectPath={project.projectPath}
            selectedSessionKey={selectedSessionKey}
            onSelect={onSelectSession}
          />
        </div>
      ) : null}
    </li>
  );
}

function ProjectSessionPreview({
  bridge,
  projectPath,
  selectedSessionKey,
  onSelect,
}: {
  bridge: BridgeDataSource;
  projectPath: string;
  selectedSessionKey: string | null;
  onSelect: (session: BridgeSessionSummary) => void;
}) {
  const [sessions, setSessions] = useState<BridgeSessionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);
  const [visibleCount, setVisibleCount] = useState(INITIAL_SESSION_COUNT);
  const consecutiveFailures = useRef(0);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    setLoading(sessions.length === 0);
    setError(null);
    setRetrying(false);
    const stop = bridge.subscribeProjectSessions(
      projectPath,
      (snapshot) => {
        setSessions(snapshot);
        setLoading(false);
        setRetrying(false);
        consecutiveFailures.current = 0;
      },
      (reason) => {
        setError(reason);
        setLoading(false);
        setRetrying(true);
        const delay = retryDelayMs(consecutiveFailures.current);
        consecutiveFailures.current += 1;
        timer = setTimeout(() => setRetryNonce((current) => current + 1), delay);
      },
    );
    return () => {
      if (timer !== undefined) clearTimeout(timer);
      stop();
    };
  }, [bridge, projectPath, retryNonce]);

  if (loading) return <InlineStatus>Loading sessions…</InlineStatus>;
  if (error) return <SidebarError message={`Sessions unavailable: ${error}`} retrying={retrying} compact />;
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
  compact = false,
}: {
  message: string;
  retrying: boolean;
  compact?: boolean;
}) {
  return (
    <div role="alert" className={`${compact ? "px-8 py-3" : "p-4"} text-(length:--agent-panel-fs-sidebar-meta,13px)`}>
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

function SourceBadge({ source }: { source: string }) {
  const label = source === "claude" ? "Claude" : source === "codex" ? "Codex" : source === "pi" ? "Pi" : source;
  const cls =
    source === "claude"
      ? "bg-violet-500/20 text-violet-500 dark:text-violet-400"
      : source === "codex"
        ? "bg-amber-500/20 text-amber-600 dark:text-amber-400"
        : source === "pi"
          ? "bg-cyan-500/20 text-cyan-700 dark:text-cyan-400"
          : "bg-muted text-muted-foreground";
  return (
    <span
      aria-label={`Source: ${label}`}
      className={`inline-flex items-center rounded px-1.5 py-0.5 font-mono text-(length:--agent-panel-fs-sidebar-chip,11px) font-semibold uppercase tracking-wide ${cls}`}
    >
      {label}
    </span>
  );
}
