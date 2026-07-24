import { useState, useEffect, useCallback } from "react";
import { LoaderCircle, Terminal as TerminalIcon, X } from "lucide-react";
import type {
  AgentTerminalContext,
  AgentTerminalRequest,
  AgentTerminalStatus,
  BridgeDataSource,
  BridgeProject,
  BridgeSessionSummary,
} from "../features/activity-feed/data-source/BridgeDataSource";
import { DataSourceProvider } from "../features/activity-feed/data-source/AgentDataSourceContext";
import { ActivityFeed } from "../features/activity-feed/ActivityFeed";

type NavState =
  | { view: "projects" }
  | { view: "sessions"; project: BridgeProject }
  | { view: "thread"; project: BridgeProject; session: BridgeSessionSummary };

interface Props {
  bridge: BridgeDataSource;
}

type TerminalState =
  | { kind: "idle" }
  | { kind: "loading"; request: AgentTerminalRequest }
  | { kind: "ready"; request: AgentTerminalRequest; ptySessionName: string }
  | { kind: "closing"; request: AgentTerminalRequest }
  | { kind: "error"; request: AgentTerminalRequest; code: string }
  | { kind: "ended"; request: AgentTerminalRequest; exitStatus?: number };

function terminalRequest(state: TerminalState): AgentTerminalRequest | null {
  return state.kind === "idle" ? null : state.request;
}

function sameRequest(
  request: AgentTerminalRequest,
  status: AgentTerminalStatus,
): boolean {
  return (
    request.requestId === status.requestId &&
    request.context.projectPath === status.context.projectPath &&
    request.context.source === status.context.source &&
    request.context.sessionId === status.context.sessionId
  );
}

export function App({ bridge }: Props) {
  const [nav, setNav] = useState<NavState>({ view: "projects" });
  const [projects, setProjects] = useState<BridgeProject[]>([]);
  const [sessions, setSessions] = useState<BridgeSessionSummary[]>([]);
  const [loadingLayer, setLoadingLayer] = useState(true);
  const [layerError, setLayerError] = useState<string | null>(null);
  const [terminal, setTerminal] = useState<TerminalState>({ kind: "idle" });

  useEffect(() => {
    setLoadingLayer(true);
    setLayerError(null);
    if (nav.view === "projects") {
      setSessions([]);
      return bridge.subscribeProjects(
        (snapshot) => {
          setProjects(snapshot);
          setLoadingLayer(false);
        },
        (reason) => {
          setLayerError(reason);
          setLoadingLayer(false);
        },
      );
    }
    if (nav.view === "sessions") {
      setProjects([]);
      return bridge.subscribeProjectSessions(
        nav.project.projectPath,
        (snapshot) => {
          setSessions(snapshot);
          setLoadingLayer(false);
        },
        (reason) => {
          setLayerError(reason);
          setLoadingLayer(false);
        },
      );
    }
    setProjects([]);
    setSessions([]);
    setLoadingLayer(false);
    return undefined;
  }, [bridge, nav]);

  useEffect(
    () =>
      bridge.subscribeTerminalStatus((status) => {
        setTerminal((current) => {
          const request = terminalRequest(current);
          if (!request || !sameRequest(request, status)) return current;
          switch (status.kind) {
            case "ready":
              if (current.kind !== "loading") return current;
              return {
                kind: "ready",
                request,
                ptySessionName: status.ptySessionName,
              };
            case "error":
              if (current.kind === "error" || current.kind === "ended") return current;
              return { kind: "error", request, code: status.code };
            case "ended":
              if (current.kind === "error" || current.kind === "ended") return current;
              return {
                kind: "ended",
                request,
                exitStatus: status.exitStatus,
              };
          }
        });
      }),
    [bridge],
  );

  const openProject = useCallback((project: BridgeProject) => {
    setNav({ view: "sessions", project });
  }, []);

  const endCurrentTerminalContext = useCallback(() => {
    const request = terminalRequest(terminal);
    if (!request) return;
    if (
      terminal.kind === "loading" ||
      terminal.kind === "ready"
    ) {
      bridge.closeTerminal(request);
    }
    bridge.endTerminalContext(request);
    setTerminal({ kind: "idle" });
  }, [bridge, terminal]);

  const openSession = useCallback(
    (project: BridgeProject, session: BridgeSessionSummary) => {
      if (nav.view === "thread") endCurrentTerminalContext();
      setNav({ view: "thread", project, session });
    },
    [endCurrentTerminalContext, nav.view],
  );

  const goBack = useCallback(() => {
    if (nav.view === "thread") {
      endCurrentTerminalContext();
      setNav({ view: "sessions", project: nav.project });
      return;
    }
    setNav({ view: "projects" });
  }, [endCurrentTerminalContext, nav]);

  const openTerminal = useCallback(() => {
    if (nav.view !== "thread") return;
    const context: AgentTerminalContext = {
      projectPath: nav.project.projectPath,
      source: nav.session.source,
      sessionId: nav.session.sessionId,
    };
    const request = bridge.createTerminalRequest(context);
    setTerminal({ kind: "loading", request });
    bridge.openTerminal(request);
  }, [bridge, nav]);

  const closeTerminal = useCallback(() => {
    const request = terminalRequest(terminal);
    if (!request) return;
    bridge.closeTerminal(request);
    setTerminal({ kind: "closing", request });
  }, [bridge, terminal]);

  return (
    <DataSourceProvider source={bridge}>
      <div className="flex h-dvh flex-col bg-background text-foreground">
        {/* Header */}
        {/* The native client insets this webview below its Control/Agent toggle,
            which owns the top safe area. So the header uses a plain top pad (no
            safe-area inset) and sits directly under that native switcher. */}
        <header className="flex shrink-0 items-center gap-3 border-b border-border bg-card px-4 py-3">
          {nav.view !== "projects" ? (
            <button
              type="button"
              onClick={goBack}
              aria-label="Go back"
              className="flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground active:bg-muted/80"
            >
              <svg
                width="20"
                height="20"
                viewBox="0 0 20 20"
                fill="none"
                aria-hidden
              >
                <path
                  d="M12 5L7 10L12 15"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          ) : (
            <div className="h-9 w-9" aria-hidden />
          )}
          <h1 className="flex-1 truncate text-center text-[15px] font-semibold leading-none text-foreground">
            {nav.view === "projects"
              ? "Agent Feed"
              : nav.view === "sessions"
                ? nav.project.displayName ?? nav.project.projectPath.split("/").pop()
                : nav.session.title ?? nav.session.sessionId}
          </h1>
          {/* Right spacer to center the title */}
          <div className="h-9 w-9" aria-hidden />
        </header>

        {/* Content. `main` is NOT a scroll container: each leaf view owns its
            own scroll. This matters for the thread view -- ActivityFeed's sticky
            headers key off ITS internal scroll container's scrollTop, so if
            `main` scrolled instead, that scrollTop would stay 0 and the sticky
            user/current headers would never engage. The two list views get their
            own overflow-y-auto wrappers (with the bottom safe-area inset so the
            last row clears the iOS home indicator). */}
        <main className="min-h-0 flex-1 overflow-hidden">
          {nav.view === "projects" ? (
            <div className="h-full overflow-y-auto pb-[env(safe-area-inset-bottom)]">
              <ProjectList
                projects={projects}
                onSelect={openProject}
                loading={loadingLayer}
                error={layerError}
              />
            </div>
          ) : nav.view === "sessions" ? (
            <div className="h-full overflow-y-auto pb-[env(safe-area-inset-bottom)]">
              <SessionList
                sessions={sessions}
                loading={loadingLayer}
                error={layerError}
                onSelect={(s) => openSession(nav.project, s)}
              />
            </div>
          ) : (
            // key on sessionId so switching sessions mounts a fresh
            // ActivityFeed: its internal UI state (collapsed/expandedTools/
            // sticky/scroll) resets per thread instead of carrying over.
            // px-4 gives the thread a screen-edge gutter (matching the project
            // and session list rows) so the reused (desktop-dense) ActivityFeed
            // prose and rows are not flush against the phone bezel. Padding the
            // wrapper keeps the shared component untouched.
            <div key={nav.session.sessionId} className="h-full px-4">
              <ActivityFeed
                source={nav.session.source}
                sessionId={nav.session.sessionId}
              />
            </div>
          )}
        </main>
        {nav.view === "thread" ? (
          <TerminalBand
            source={nav.session.source}
            state={terminal}
            onOpen={openTerminal}
            onClose={closeTerminal}
          />
        ) : null}
      </div>
    </DataSourceProvider>
  );
}

function TerminalBand({
  source,
  state,
  onOpen,
  onClose,
}: {
  source: "claude" | "codex";
  state: TerminalState;
  onOpen: () => void;
  onClose: () => void;
}) {
  const harness = source === "claude" ? "Claude" : "Codex";
  const launcher = (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`Open ${harness} terminal`}
      className="flex min-h-11 items-center gap-2 px-4 text-[14px] font-medium text-foreground transition-colors hover:bg-muted active:bg-muted/80"
    >
      <TerminalIcon className="h-4 w-4" aria-hidden />
      <span>Open {harness}</span>
    </button>
  );

  let status: React.ReactNode = null;
  if (state.kind === "loading" || state.kind === "closing") {
    status = (
      <div role="status" className="flex min-h-11 items-center gap-2 px-4 text-[14px] text-muted-foreground">
        <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden />
        <span>{state.kind === "loading" ? `Opening ${harness}` : `Closing ${harness}`}</span>
      </div>
    );
  } else if (state.kind === "ready") {
    status = (
      <div className="flex min-h-11 items-center gap-2 px-4">
        <div role="status" className="flex min-w-0 flex-1 items-center gap-2 text-[14px] text-foreground">
          <TerminalIcon className="h-4 w-4 shrink-0" aria-hidden />
          <span className="truncate">{harness} terminal ready</span>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={`Close ${harness} terminal`}
          className="flex h-9 w-9 shrink-0 items-center justify-center text-muted-foreground transition-colors hover:bg-muted hover:text-foreground active:bg-muted/80"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>
    );
  } else if (state.kind === "error") {
    status = (
      <div className="flex min-h-11 items-center justify-between gap-3">
        <div role="status" className="min-w-0 flex-1 px-4 text-[13px] text-destructive">
          {harness} terminal unavailable: {state.code}
        </div>
        {launcher}
      </div>
    );
  } else if (state.kind === "ended") {
    status = (
      <div className="flex min-h-11 items-center justify-between gap-3">
        <div role="status" className="min-w-0 flex-1 px-4 text-[13px] text-muted-foreground">
          {harness} terminal ended
        </div>
        {launcher}
      </div>
    );
  }

  return (
    <footer className="shrink-0 border-t border-border bg-card pb-[env(safe-area-inset-bottom)]">
      {state.kind === "idle" ? launcher : status}
    </footer>
  );
}

// ---------------------------------------------------------------------------
// Project list
// ---------------------------------------------------------------------------

function ProjectList({
  projects,
  onSelect,
  loading,
  error,
}: {
  projects: BridgeProject[];
  onSelect: (p: BridgeProject) => void;
  loading: boolean;
  error: string | null;
}) {
  if (loading) {
    return (
      <div role="status" className="flex h-full items-center justify-center p-8 text-muted-foreground">
        Loading projects…
      </div>
    );
  }

  if (error) {
    return (
      <div role="alert" className="flex h-full items-center justify-center p-8 text-center text-destructive">
        Projects unavailable: {error}
      </div>
    );
  }

  if (projects.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center p-8 text-center">
        <p className="text-[15px] text-muted-foreground">No projects yet</p>
      </div>
    );
  }

  return (
    <ul className="divide-y divide-border" role="list" aria-label="Projects">
      {projects.map((project) => {
        const name =
          project.displayName ?? project.projectPath.split("/").pop() ?? project.projectPath;
        const sources: Array<"claude" | "codex"> = [];
        if (project.sourceCounts.claude > 0) sources.push("claude");
        if (project.sourceCounts.codex > 0) sources.push("codex");

        return (
          <li key={project.projectPath}>
            <button
              type="button"
              onClick={() => onSelect(project)}
              className="flex w-full items-center gap-4 px-4 py-4 text-left transition-colors hover:bg-muted/50 active:bg-muted/80"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-[15px] font-medium text-foreground">
                    {name}
                  </span>
                </div>
                <div className="mt-1 flex items-center gap-2">
                  {sources.map((src) => (
                    <SourceBadge key={src} source={src} />
                  ))}
                  <span className="text-[13px] text-muted-foreground">
                    {project.sessionCount}{" "}
                    {project.sessionCount === 1 ? "session" : "sessions"}
                  </span>
                </div>
              </div>
              <ChevronRight />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Session list
// ---------------------------------------------------------------------------

function SessionList({
  sessions,
  loading,
  error,
  onSelect,
}: {
  sessions: BridgeSessionSummary[];
  loading: boolean;
  error: string | null;
  onSelect: (s: BridgeSessionSummary) => void;
}) {
  if (loading) {
    return (
      <div role="status" className="flex h-full items-center justify-center p-8 text-muted-foreground">
        Loading sessions…
      </div>
    );
  }

  if (error) {
    return (
      <div role="alert" className="flex h-full items-center justify-center p-8 text-center text-destructive">
        Sessions unavailable: {error}
      </div>
    );
  }

  if (sessions.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <p className="text-[15px] text-muted-foreground">No sessions in this project</p>
      </div>
    );
  }

  return (
    <ul className="divide-y divide-border" role="list" aria-label="Sessions">
      {sessions.map((session) => {
        const title = session.title ?? session.sessionId;
        const time = new Date(session.lastEventAt).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        });

        return (
          <li key={`${session.source}:${session.sessionId}`}>
            <button
              type="button"
              onClick={() => onSelect(session)}
              className="flex w-full items-center gap-4 px-4 py-4 text-left transition-colors hover:bg-muted/50 active:bg-muted/80"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <SourceBadge source={session.source} />
                  {session.activity === "live" ? (
                    <span
                      aria-label="Live"
                      className="h-2 w-2 shrink-0 rounded-full bg-green-500"
                    />
                  ) : null}
                </div>
                <p className="mt-1 truncate text-[15px] font-medium text-foreground">
                  {title}
                </p>
                <p className="mt-0.5 text-[13px] text-muted-foreground">{time}</p>
              </div>
              <ChevronRight />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Shared small components
// ---------------------------------------------------------------------------

function SourceBadge({ source }: { source: "claude" | "codex" }) {
  const label = source === "claude" ? "Claude" : "Codex";
  const cls =
    source === "claude"
      ? "bg-violet-500/20 text-violet-400"
      : "bg-amber-500/20 text-amber-400";
  return (
    <span
      aria-label={`Source: ${label}`}
      className={`inline-flex items-center rounded px-1.5 py-0.5 font-mono text-[11px] font-semibold uppercase tracking-wide ${cls}`}
    >
      {label}
    </span>
  );
}

function ChevronRight() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 18 18"
      fill="none"
      aria-hidden
      className="shrink-0 text-muted-foreground/50"
    >
      <path
        d="M7 4L12 9L7 14"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
