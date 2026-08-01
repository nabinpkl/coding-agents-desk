import { useState, useEffect, useCallback, useRef } from "react";
import { LoaderCircle, Terminal as TerminalIcon } from "lucide-react";
import type {
  AgentTerminalContext,
  AgentTerminalRequest,
  AgentTerminalStatus,
  BridgeDataSource,
  BridgeProject,
  BridgeSessionSummary,
} from "../features/activity-feed/data-source/BridgeDataSource";
import type { EventMode } from "../features/activity-feed/data-source/AgentDataSource";
import { DataSourceProvider } from "../features/activity-feed/data-source/AgentDataSourceContext";
import { ActivityFeed } from "../features/activity-feed/ActivityFeed";
import { FontSizeRoot } from "../features/activity-feed/fontStore";
import { loadEventMode, storeEventMode } from "../features/activity-feed/eventModeStore";

/**
 * How long to wait before re-subscribing after a failure.
 *
 * Doubling from a second, capped, because the two failures worth surviving have
 * very different shapes: a sidecar restart is back within seconds, while a
 * sidecar that cannot start at all should not be asked once a second forever.
 * Each attempt already costs the host's own readiness wait, so this is the pause
 * on top of that, not the whole cadence.
 */
function retryDelayMs(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 15000);
}

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
  // The thread's own controls render into the header through this node, so the
  // feed does not spend a band of its own on them. Held in state, not a ref,
  // because the feed has to re-render once the node exists.
  const [threadControlsHost, setThreadControlsHost] = useState<HTMLDivElement | null>(null);
  // Owned here rather than in the feed so the choice survives switching threads, and
  // so the feed can remount on a change -- every event index it holds is counted in
  // the mode, so none of them survives a switch.
  const [eventMode, setEventMode] = useState<EventMode>(loadEventMode);
  const toggleEventMode = useCallback(() => {
    setEventMode((current) => {
      const next = current === "nice" ? "raw" : "nice";
      storeEventMode(next);
      return next;
    });
  }, []);

  // Incremented to re-run the subscription below after a failure.
  //
  // A visibility subscription is one-shot: the host tears the stream down when it
  // reports an error, so without this the first failure was permanent. That is how
  // a restored Agents window that came up one second before its sidecar sat on
  // "agent feed is not ready" for a whole session. The host now waits for a
  // sidecar that is starting, which covers the launch race; this covers what is
  // left -- an outage longer than that wait, or a sidecar that dies and restarts
  // while the window is open.
  //
  // Only ever increments. The consecutive-failure count that sets the delay lives
  // in a ref instead, because resetting it on success would be a state change in
  // this effect's own dependencies -- which tears down the subscription that just
  // succeeded and re-subscribes, leaving the viewer back on "Loading".
  const [retryNonce, setRetryNonce] = useState(0);
  const [retrying, setRetrying] = useState(false);
  const consecutiveFailures = useRef(0);

  // A fresh layer starts from the short delay rather than inheriting the backoff
  // of whatever the viewer was looking at before.
  useEffect(() => {
    consecutiveFailures.current = 0;
  }, [nav]);

  useEffect(() => {
    setLoadingLayer(true);
    setLayerError(null);
    setRetrying(false);
    if (nav.view === "thread") {
      setProjects([]);
      setSessions([]);
      setLoadingLayer(false);
      return undefined;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onError = (reason: string) => {
      setLayerError(reason);
      setLoadingLayer(false);
      setRetrying(true);
      const delay = retryDelayMs(consecutiveFailures.current);
      consecutiveFailures.current += 1;
      timer = setTimeout(() => setRetryNonce((n) => n + 1), delay);
    };
    const onLoaded = () => {
      setLoadingLayer(false);
      setRetrying(false);
      consecutiveFailures.current = 0;
    };
    const stop =
      nav.view === "projects"
        ? (setSessions([]),
          bridge.subscribeProjects((snapshot) => {
            setProjects(snapshot);
            onLoaded();
          }, onError))
        : (setProjects([]),
          bridge.subscribeProjectSessions(
            nav.project.projectPath,
            (snapshot) => {
              setSessions(snapshot);
              onLoaded();
            },
            onError,
          ));
    return () => {
      if (timer !== undefined) clearTimeout(timer);
      stop?.();
    };
  }, [bridge, nav, retryNonce]);

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
      {/* One home for the bottom safe-area inset. It used to be repeated on
          each leaf view and on the terminal footer, which double-inset any
          combination of the two. Applying it to the column means every view,
          and the notice below main, clears the iOS home indicator. */}
      <div className="flex h-dvh flex-col bg-background pb-[env(safe-area-inset-bottom)] text-foreground">
        {/* Every chosen font token becomes a CSS variable on <html>. Without
            this mounted, all ~20 `var(--agent-panel-fs-*)` readers silently fall
            back to their inline literals and the token system does nothing. */}
        <FontSizeRoot />
        {/* The one row of app chrome. It used to be three (this header, the
            feed's own fold bar, a terminal footer), which cost 157px of a 692px
            panel before any transcript. The title is left-aligned rather than
            centred because centring it needed a matching spacer opposite the
            back button, and that spacer is what truncated real session titles.
            The native client insets this webview below its Control/Agent toggle,
            which owns the top safe area, so no safe-area inset here. */}
        <header className="flex shrink-0 items-center gap-2 border-b border-border bg-card px-2 py-1.5">
          {nav.view !== "projects" ? (
            <button
              type="button"
              onClick={goBack}
              aria-label="Go back"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground active:bg-muted/80"
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
          ) : null}
          <h1 className="min-w-0 flex-1 truncate px-1 text-(length:--agent-panel-fs-sidebar-title,15px) font-semibold leading-none text-foreground">
            {nav.view === "projects"
              ? "Agent Feed"
              : nav.view === "sessions"
                ? nav.project.displayName ?? nav.project.projectPath.split("/").pop()
                : nav.session.title ?? nav.session.sessionId}
          </h1>
          <div ref={setThreadControlsHost} className="flex shrink-0 items-center" />
          {nav.view === "thread" ? (
            <TerminalControl
              source={nav.session.source}
              state={terminal}
              onOpen={openTerminal}
              onClose={closeTerminal}
            />
          ) : null}
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
            <div className="h-full overflow-y-auto">
              <ProjectList
                projects={projects}
                onSelect={openProject}
                loading={loadingLayer}
                error={layerError}
                retrying={retrying}
              />
            </div>
          ) : nav.view === "sessions" ? (
            <div className="h-full overflow-y-auto">
              <SessionList
                sessions={sessions}
                loading={loadingLayer}
                error={layerError}
                retrying={retrying}
                onSelect={(s) => openSession(nav.project, s)}
              />
            </div>
          ) : (
            // key on sessionId so switching sessions mounts a fresh
            // ActivityFeed: its internal UI state (collapsed/expandedTools/
            // sticky/scroll) resets per thread instead of carrying over.
            //
            // No horizontal padding here. The rows own their gutter, and
            // stacking a wrapper pad on top of the row pad, the card pad, and
            // the body indent put the first character of prose 68px from the
            // left edge of a 480px panel.
            //
            // The bottom safe-area inset lives here now that the terminal
            // footer is gone: it is what keeps the last row clear of the iOS
            // home indicator.
            // The mode is part of the key: switching it renumbers every event, so
            // the feed's collapsed set, sticky selection, virtualizer measurements
            // and paging window are all addressed in the mode they were built in
            // and none of them can carry across. A remount is the honest answer,
            // and it lands at the tail exactly as switching threads does.
            <div
              key={`${nav.session.sessionId}:${eventMode}`}
              className="h-full"
            >
              <ActivityFeed
                source={nav.session.source}
                sessionId={nav.session.sessionId}
                mode={eventMode}
                onToggleMode={toggleEventMode}
                controlsHost={threadControlsHost}
              />
            </div>
          )}
        </main>
        {nav.view === "thread" ? (
          <TerminalNotice source={nav.session.source} state={terminal} />
        ) : null}
      </div>
    </DataSourceProvider>
  );
}

function harnessName(source: "claude" | "codex"): string {
  return source === "claude" ? "Claude" : "Codex";
}

/**
 * The terminal's open/close affordance, as one icon in the header.
 *
 * This replaces a permanent 45px footer band that spent a full row on a single
 * button. Progress and ready are carried by the icon itself and announced
 * through an off-screen live region, so those states now cost no layout at all;
 * failure and exit are the only states that still claim pixels, via
 * `TerminalNotice`, because those are the ones the viewer has to read.
 */
function TerminalControl({
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
  const harness = harnessName(source);
  const busy = state.kind === "loading" || state.kind === "closing";
  const ready = state.kind === "ready";
  const label = ready ? `Close ${harness} terminal` : `Open ${harness} terminal`;
  const announcement =
    state.kind === "loading"
      ? `Opening ${harness}`
      : state.kind === "closing"
        ? `Closing ${harness}`
        : ready
          ? `${harness} terminal ready`
          : null;
  return (
    <>
      <button
        type="button"
        onClick={ready ? onClose : onOpen}
        disabled={busy}
        aria-label={label}
        title={label}
        className={
          "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors disabled:opacity-60 " +
          (ready
            ? "bg-primary/20 text-primary hover:bg-primary/30"
            : "text-muted-foreground hover:bg-muted hover:text-foreground active:bg-muted/80")
        }
      >
        {busy ? (
          <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden />
        ) : (
          <TerminalIcon className="h-4 w-4" aria-hidden />
        )}
      </button>
      {/* Announced, not drawn. The icon is the visual state; a sighted viewer
          reading a spinner does not also need a sentence about it. */}
      {announcement ? (
        <span role="status" className="sr-only">
          {announcement}
        </span>
      ) : null}
    </>
  );
}

/**
 * The only terminal states that get a visible row: the ones the viewer has to
 * act on. Everything else is announced by `TerminalControl` and costs no space.
 */
function TerminalNotice({
  source,
  state,
}: {
  source: "claude" | "codex";
  state: TerminalState;
}) {
  const harness = harnessName(source);
  if (state.kind === "error") {
    return (
      <div
        role="status"
        className="shrink-0 border-t border-border bg-destructive/10 px-3 py-1 text-(length:--agent-panel-fs-sidebar-meta,13px) text-destructive"
      >
        {harness} terminal unavailable: {state.code}
      </div>
    );
  }
  if (state.kind === "ended") {
    return (
      <div
        role="status"
        className="shrink-0 border-t border-border px-3 py-1 text-(length:--agent-panel-fs-sidebar-meta,13px) text-muted-foreground"
      >
        {harness} terminal ended
      </div>
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Project list
// ---------------------------------------------------------------------------

function ProjectList({
  projects,
  onSelect,
  loading,
  error,
  retrying,
}: {
  projects: BridgeProject[];
  onSelect: (p: BridgeProject) => void;
  loading: boolean;
  error: string | null;
  retrying: boolean;
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
      <div role="alert" className="flex h-full flex-col items-center justify-center gap-1 p-8 text-center">
        <span className="text-destructive">Projects unavailable: {error}</span>
        {retrying ? <RetryNotice /> : null}
      </div>
    );
  }

  if (projects.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center p-8 text-center">
        <p className="text-(length:--agent-panel-fs-sidebar-body,15px) text-muted-foreground">No projects yet</p>
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
                  <span className="truncate text-(length:--agent-panel-fs-sidebar-body,15px) font-medium text-foreground">
                    {name}
                  </span>
                </div>
                <div className="mt-1 flex items-center gap-2">
                  {sources.map((src) => (
                    <SourceBadge key={src} source={src} />
                  ))}
                  <span className="text-(length:--agent-panel-fs-sidebar-meta,13px) text-muted-foreground">
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
  retrying,
  onSelect,
}: {
  sessions: BridgeSessionSummary[];
  loading: boolean;
  error: string | null;
  retrying: boolean;
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
      <div role="alert" className="flex h-full flex-col items-center justify-center gap-1 p-8 text-center">
        <span className="text-destructive">Sessions unavailable: {error}</span>
        {retrying ? <RetryNotice /> : null}
      </div>
    );
  }

  if (sessions.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <p className="text-(length:--agent-panel-fs-sidebar-body,15px) text-muted-foreground">No sessions in this project</p>
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
                <p className="mt-1 truncate text-(length:--agent-panel-fs-sidebar-body,15px) font-medium text-foreground">
                  {title}
                </p>
                <p className="mt-0.5 text-(length:--agent-panel-fs-sidebar-meta,13px) text-muted-foreground">{time}</p>
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

/** Says the window is still trying, so an error does not read as a dead end. */
function RetryNotice() {
  return (
    <span className="flex items-center gap-1.5 text-(length:--agent-panel-fs-sidebar-meta,13px) text-muted-foreground">
      <LoaderCircle className="size-3 animate-spin" aria-hidden />
      Retrying…
    </span>
  );
}

function SourceBadge({ source }: { source: "claude" | "codex" }) {
  const label = source === "claude" ? "Claude" : "Codex";
  const cls =
    source === "claude"
      ? "bg-violet-500/20 text-violet-400"
      : "bg-amber-500/20 text-amber-400";
  return (
    <span
      aria-label={`Source: ${label}`}
      className={`inline-flex items-center rounded px-1.5 py-0.5 font-mono text-(length:--agent-panel-fs-sidebar-chip,11px) font-semibold uppercase tracking-wide ${cls}`}
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
