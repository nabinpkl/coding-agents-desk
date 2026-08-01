import { useState, useEffect, useCallback, useRef } from "react";
import { LoaderCircle, Menu, Send, Square, Terminal as TerminalIcon } from "lucide-react";
import type {
  AgentExtensionUIRequest,
  AgentTerminalContext,
  AgentTerminalRequest,
  AgentTerminalStatus,
  BridgeDataSource,
  BridgeProject,
  BridgeSessionSummary,
} from "../features/activity-feed/data-source/BridgeDataSource";
import type { AgentSessionControlState, EventMode } from "../features/activity-feed/data-source/AgentDataSource";
import { DataSourceProvider } from "../features/activity-feed/data-source/AgentDataSourceContext";
import { ActivityFeed } from "../features/activity-feed/ActivityFeed";
import { FontSizeRoot } from "../features/activity-feed/fontStore";
import { loadEventMode, storeEventMode } from "../features/activity-feed/eventModeStore";
import {
  AgentSidebar,
  AgentSidebarDialog,
  useCompactSidebar,
} from "../features/sidebar/AgentSidebar";

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

interface SelectedThread {
  project: BridgeProject;
  session: BridgeSessionSummary;
}

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
  const [selectedThread, setSelectedThread] = useState<SelectedThread | null>(null);
  const [projects, setProjects] = useState<BridgeProject[]>([]);
  const [loadingLayer, setLoadingLayer] = useState(true);
  const [layerError, setLayerError] = useState<string | null>(null);
  const [terminal, setTerminal] = useState<TerminalState>({ kind: "idle" });
  const [creatingProjectPath, setCreatingProjectPath] = useState<string | null>(null);
  const [creationErrors, setCreationErrors] = useState<Map<string, string>>(new Map());
  const [draft, setDraft] = useState("");
  const [commandPending, setCommandPending] = useState(false);
  const [commandError, setCommandError] = useState<string | null>(null);
  const [sessionState, setSessionState] = useState<AgentSessionControlState>({
    runState: "idle",
    queue: { steer: 0, followUp: 0 },
  });
  const [extensionUI, setExtensionUI] = useState<AgentExtensionUIRequest[]>([]);
  const compactSidebar = useCompactSidebar();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawerTriggerRef = useRef<HTMLButtonElement>(null);
  const openedInitialDrawer = useRef(false);
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

  useEffect(() => {
    setLoadingLayer(true);
    setLayerError(null);
    setRetrying(false);
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
    const stop = bridge.subscribeProjects((snapshot) => {
      setProjects(snapshot);
      onLoaded();
    }, onError);
    return () => {
      if (timer !== undefined) clearTimeout(timer);
      stop?.();
    };
  }, [bridge, retryNonce]);

  useEffect(() => {
    if (!compactSidebar) {
      setDrawerOpen(false);
      return;
    }
    if (!selectedThread && projects.length > 0 && !openedInitialDrawer.current) {
      openedInitialDrawer.current = true;
      setDrawerOpen(true);
    }
  }, [compactSidebar, projects.length, selectedThread]);

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

  useEffect(
    () => bridge.subscribeExtensionUI((event) => {
      if (event.type === "dismiss") {
        setExtensionUI((current) => current.filter((item) => !(
          item.source === event.source &&
          item.sessionId === event.sessionId &&
          item.requestId === event.requestId
        )));
        return;
      }
      const request = event.request;
      setExtensionUI((current) => {
        const next = [
          ...current.filter((item) => !(
          item.source === request.source &&
          item.sessionId === request.sessionId &&
          item.requestId === request.requestId
          )),
          request,
        ];
        const prompts = next.filter((item) => item.expectsResponse);
        const notices = next.filter((item) => !item.expectsResponse).slice(-8);
        return [...notices, ...prompts];
      });
    }),
    [bridge],
  );

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
      if (selectedThread) endCurrentTerminalContext();
      setEventMode((current) => session.capabilities.modes.includes(current)
        ? current
        : (session.capabilities.modes[0] ?? "nice"));
      setDraft("");
      setCommandError(null);
      setSessionState({ runState: "idle", queue: { steer: 0, followUp: 0 } });
      setExtensionUI([]);
      setSelectedThread({ project, session });
      if (compactSidebar) setDrawerOpen(false);
    },
    [compactSidebar, endCurrentTerminalContext, selectedThread],
  );

  const openTerminal = useCallback(() => {
    if (!selectedThread) return;
    if (!isTerminalSource(selectedThread.session.source) || !selectedThread.session.capabilities.canOpenTerminal) return;
    const context: AgentTerminalContext = {
      projectPath: selectedThread.project.projectPath,
      source: selectedThread.session.source,
      sessionId: selectedThread.session.sessionId,
    };
    const request = bridge.createTerminalRequest(context);
    setTerminal({ kind: "loading", request });
    bridge.openTerminal(request);
  }, [bridge, selectedThread]);

  const createPiSession = useCallback(async (project: BridgeProject) => {
    if (creatingProjectPath) return;
    setCreatingProjectPath(project.projectPath);
    setCreationErrors((current) => {
      const next = new Map(current);
      next.delete(project.projectPath);
      return next;
    });
    try {
      const receipt = await bridge.createSession(project.projectPath, "pi");
      if (!receipt.session) {
        throw new Error("created session response did not include a session descriptor");
      }
      openSession(project, receipt.session);
    } catch (error) {
      const message = String((error as Error).message ?? error);
      setCreationErrors((current) => new Map(current).set(project.projectPath, message));
    } finally {
      setCreatingProjectPath(null);
    }
  }, [bridge, creatingProjectPath, openSession]);

  const sendPrompt = useCallback(async (delivery: "next" | "steer") => {
    if (!selectedThread || commandPending || !draft.trim()) return;
    const text = draft.trim();
    setCommandPending(true);
    setCommandError(null);
    try {
      await bridge.sendMessage(selectedThread.session, text, delivery);
      setDraft("");
    } catch (error) {
      setCommandError(String((error as Error).message ?? error));
    } finally {
      setCommandPending(false);
    }
  }, [bridge, commandPending, draft, selectedThread]);

  const abortRun = useCallback(async () => {
    if (!selectedThread || commandPending) return;
    setCommandPending(true);
    setCommandError(null);
    try {
      await bridge.abortSession(selectedThread.session);
    } catch (error) {
      setCommandError(String((error as Error).message ?? error));
    } finally {
      setCommandPending(false);
    }
  }, [bridge, commandPending, selectedThread]);

  const closeTerminal = useCallback(() => {
    const request = terminalRequest(terminal);
    if (!request) return;
    bridge.closeTerminal(request);
    setTerminal({ kind: "closing", request });
  }, [bridge, terminal]);

  return (
    <DataSourceProvider source={bridge}>
      <div className="flex h-dvh min-w-0 bg-background text-foreground">
        <FontSizeRoot />
        {compactSidebar ? (
          <AgentSidebarDialog
            open={drawerOpen}
            triggerRef={drawerTriggerRef}
            onRequestClose={() => setDrawerOpen(false)}
            bridge={bridge}
            projects={projects}
            loading={loadingLayer}
            error={layerError}
            retrying={retrying}
            selectedProjectPath={selectedThread?.project.projectPath ?? null}
            selectedSessionKey={selectedThread ? `${selectedThread.session.source}:${selectedThread.session.sessionId}` : null}
            creatingProjectPath={creatingProjectPath}
            creationErrors={creationErrors}
            onSelectSession={openSession}
            onCreatePiSession={(project) => void createPiSession(project)}
          />
        ) : (
          <aside className="h-full w-66 shrink-0 border-r border-border" aria-label="Agent navigation">
            <AgentSidebar
              bridge={bridge}
              projects={projects}
              loading={loadingLayer}
              error={layerError}
              retrying={retrying}
              selectedProjectPath={selectedThread?.project.projectPath ?? null}
              selectedSessionKey={selectedThread ? `${selectedThread.session.source}:${selectedThread.session.sessionId}` : null}
              creatingProjectPath={creatingProjectPath}
              creationErrors={creationErrors}
              onSelectSession={openSession}
              onCreatePiSession={(project) => void createPiSession(project)}
            />
          </aside>
        )}

        <div className="flex min-w-0 flex-1 flex-col pb-[env(safe-area-inset-bottom)]">
          <header className="flex min-h-11 shrink-0 items-center gap-1 border-b border-border bg-card px-1.5">
            {compactSidebar ? (
              <button
                ref={drawerTriggerRef}
                type="button"
                onClick={() => setDrawerOpen(true)}
                aria-label="Open projects"
                aria-expanded={drawerOpen}
                className="flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <Menu className="size-5" aria-hidden />
              </button>
            ) : null}
            <h1 className="min-w-0 flex-1 truncate px-1 text-(length:--agent-panel-fs-sidebar-title,15px) font-semibold leading-none text-foreground">
              {selectedThread?.session.title || selectedThread?.session.sessionId || "Agent Feed"}
            </h1>
            <div ref={setThreadControlsHost} className="flex shrink-0 items-center" />
            {selectedThread?.session.capabilities.canOpenTerminal && isTerminalSource(selectedThread.session.source) ? (
              <TerminalControl
                source={selectedThread.session.source}
                state={terminal}
                onOpen={openTerminal}
                onClose={closeTerminal}
              />
            ) : null}
          </header>

          {/* ActivityFeed remains the only thread scroll owner. The sidebar has
              its own scroller, so sticky transcript headers and virtualization
              still read the same scrollTop they did before this shell changed. */}
          <main className="min-h-0 flex-1 overflow-hidden">
            {selectedThread ? (
              <div
                key={`${selectedThread.session.sessionId}:${eventMode}`}
                className="h-full"
              >
                <ActivityFeed
                  source={selectedThread.session.source}
                  sessionId={selectedThread.session.sessionId}
                  mode={eventMode}
                  onToggleMode={toggleEventMode}
                  canToggleMode={selectedThread.session.capabilities.modes.length > 1}
                  controlsHost={threadControlsHost}
                  onSessionState={setSessionState}
                />
              </div>
            ) : (
              <div className="flex h-full items-center justify-center p-8 text-center text-(length:--agent-panel-fs-sidebar-body,15px) text-muted-foreground">
                Select a session from Projects
              </div>
            )}
          </main>
          {selectedThread?.session.capabilities.supportsExtensionUI ? (
            <ExtensionUISurface
              requests={extensionUI.filter((request) =>
                request.source === selectedThread.session.source && request.sessionId === selectedThread.session.sessionId)}
              onRespond={async (request, value) => {
                setCommandError(null);
                try {
                  await bridge.respondToExtensionUI(request, value);
                } catch (error) {
                  setCommandError(String((error as Error).message ?? error));
                  throw error;
                }
              }}
              onDismiss={(request) =>
                setExtensionUI((current) => current.filter((item) => item.requestId !== request.requestId))}
            />
          ) : null}
          {selectedThread?.session.capabilities.canSend ? (
            <AgentComposer
              draft={draft}
              onDraftChange={setDraft}
              pending={commandPending}
              error={commandError}
              state={sessionState}
              canSteer={selectedThread.session.capabilities.canSteer}
              canAbort={selectedThread.session.capabilities.canAbort}
              onSend={() => void sendPrompt("next")}
              onSteer={() => void sendPrompt("steer")}
              onAbort={() => void abortRun()}
            />
          ) : null}
          {selectedThread && isTerminalSource(selectedThread.session.source) ? (
            <TerminalNotice source={selectedThread.session.source} state={terminal} />
          ) : null}
        </div>
      </div>
    </DataSourceProvider>
  );
}

function isTerminalSource(source: string): source is "claude" | "codex" {
  return source === "claude" || source === "codex";
}

function harnessName(source: "claude" | "codex"): string {
  return source === "claude" ? "Claude" : "Codex";
}

function AgentComposer({
  draft,
  onDraftChange,
  pending,
  error,
  state,
  canSteer,
  canAbort,
  onSend,
  onSteer,
  onAbort,
}: {
  draft: string;
  onDraftChange: (value: string) => void;
  pending: boolean;
  error: string | null;
  state: AgentSessionControlState;
  canSteer: boolean;
  canAbort: boolean;
  onSend: () => void;
  onSteer: () => void;
  onAbort: () => void;
}) {
  const running = state.runState === "running";
  const queued = state.queue.followUp + state.queue.steer;
  return (
    <section aria-label="Agent prompt" className="shrink-0 border-t border-border bg-card px-2 py-2">
      <div className="flex items-end gap-1.5">
        <textarea
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              onSend();
            }
          }}
          maxLength={200_000}
          rows={1}
          placeholder={running ? "Queue the next instruction…" : "Message Pi…"}
          aria-label="Message Pi"
          className="max-h-28 min-h-9 flex-1 resize-none rounded-lg border border-border bg-background px-3 py-2 text-(length:--agent-panel-fs-sidebar-body,15px) leading-5 outline-none focus:border-primary"
        />
        {running && canSteer ? (
          <button
            type="button"
            onClick={onSteer}
            disabled={pending || !draft.trim()}
            className="h-9 rounded-lg px-2 text-(length:--agent-panel-fs-sidebar-meta,13px) font-medium text-muted-foreground hover:bg-muted disabled:opacity-40"
          >
            Steer
          </button>
        ) : null}
        {running && canAbort ? (
          <button type="button" onClick={onAbort} disabled={pending} aria-label="Stop agent" className="flex size-9 items-center justify-center rounded-lg text-destructive hover:bg-destructive/10 disabled:opacity-40">
            <Square className="size-3.5 fill-current" aria-hidden />
          </button>
        ) : null}
        <button
          type="button"
          onClick={onSend}
          disabled={pending || !draft.trim()}
          aria-label={running ? "Queue message" : "Send message"}
          className="flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
        >
          {pending ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : <Send className="size-4" aria-hidden />}
        </button>
      </div>
      {queued > 0 || error ? (
        <div className={`mt-1 px-1 text-(length:--agent-panel-fs-sidebar-meta,13px) ${error ? "text-destructive" : "text-muted-foreground"}`} role={error ? "alert" : "status"}>
          {error ?? `${queued} queued${state.queue.steer ? `, ${state.queue.steer} steering` : ""}`}
        </div>
      ) : null}
    </section>
  );
}

function ExtensionUISurface({
  requests,
  onRespond,
  onDismiss,
}: {
  requests: AgentExtensionUIRequest[];
  onRespond: (request: AgentExtensionUIRequest, value: string | boolean | null) => Promise<void>;
  onDismiss: (request: AgentExtensionUIRequest) => void;
}) {
  const request = requests.find((candidate) => candidate.expectsResponse) ?? requests.at(-1);
  if (!request) return null;
  if (!request.expectsResponse) {
    return (
      <div role="status" className="flex shrink-0 items-start gap-2 border-t border-border bg-muted/40 px-3 py-2 text-(length:--agent-panel-fs-sidebar-meta,13px)">
        <div className="min-w-0 flex-1">
          <span className="font-medium">{request.title ?? request.key ?? "Pi extension"}</span>
          {request.message ? <p className="mt-0.5 whitespace-pre-wrap text-muted-foreground">{request.message}</p> : null}
          {request.lines?.length ? <pre className="mt-1 overflow-x-auto whitespace-pre-wrap text-muted-foreground">{request.lines.join("\n")}</pre> : null}
        </div>
        <button type="button" onClick={() => onDismiss(request)} className="text-muted-foreground hover:text-foreground" aria-label="Dismiss extension notice">Dismiss</button>
      </div>
    );
  }
  return <ExtensionUIPrompt key={request.requestId} request={request} onRespond={onRespond} />;
}

function ExtensionUIPrompt({
  request,
  onRespond,
}: {
  request: AgentExtensionUIRequest;
  onRespond: (request: AgentExtensionUIRequest, value: string | boolean | null) => Promise<void>;
}) {
  const [value, setValue] = useState(request.prefill ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const respond = async (response: string | boolean | null) => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await onRespond(request, response);
    } catch (caught) {
      setError(String((caught as Error).message ?? caught));
    } finally {
      setPending(false);
    }
  };
  return (
    <section role="dialog" aria-label={request.title ?? "Pi extension request"} className="shrink-0 border-t border-primary/30 bg-primary/5 px-3 py-2">
      <p className="text-(length:--agent-panel-fs-sidebar-body,15px) font-medium">{request.title ?? "Pi extension request"}</p>
      {request.message ? <p className="mt-1 whitespace-pre-wrap text-(length:--agent-panel-fs-sidebar-meta,13px) text-muted-foreground">{request.message}</p> : null}
      {request.kind === "select" ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {request.options?.map((option) => (
            <button key={option} type="button" disabled={pending} onClick={() => void respond(option)} className="rounded-lg border border-border bg-card px-3 py-1.5 hover:bg-muted disabled:opacity-40">{option}</button>
          ))}
          <button type="button" disabled={pending} onClick={() => void respond(null)} className="rounded-lg px-3 py-1.5 text-muted-foreground hover:bg-muted disabled:opacity-40">Cancel</button>
        </div>
      ) : request.kind === "confirm" ? (
        <div className="mt-2 flex justify-end gap-2">
          <button type="button" disabled={pending} onClick={() => void respond(false)} className="rounded-lg px-3 py-1.5 text-muted-foreground hover:bg-muted disabled:opacity-40">Cancel</button>
          <button type="button" disabled={pending} onClick={() => void respond(true)} className="rounded-lg bg-primary px-3 py-1.5 text-primary-foreground disabled:opacity-40">Confirm</button>
        </div>
      ) : (
        <form className="mt-2 flex items-end gap-2" onSubmit={(event) => { event.preventDefault(); void respond(value); }}>
          {request.kind === "editor" ? (
            <textarea autoFocus disabled={pending} rows={4} maxLength={50_000} value={value} placeholder={request.placeholder} onChange={(event) => setValue(event.target.value)} className="min-w-0 flex-1 resize-y rounded-lg border border-border bg-background px-3 py-2 outline-none focus:border-primary disabled:opacity-40" />
          ) : (
            <input autoFocus disabled={pending} maxLength={50_000} value={value} placeholder={request.placeholder} onChange={(event) => setValue(event.target.value)} className="h-9 min-w-0 flex-1 rounded-lg border border-border bg-background px-3 outline-none focus:border-primary disabled:opacity-40" />
          )}
          <button type="button" disabled={pending} onClick={() => void respond(null)} className="h-9 rounded-lg px-2 text-muted-foreground hover:bg-muted disabled:opacity-40">Cancel</button>
          <button type="submit" disabled={pending} className="h-9 rounded-lg bg-primary px-3 text-primary-foreground disabled:opacity-40">Submit</button>
        </form>
      )}
      {error ? <p role="alert" className="mt-1 text-(length:--agent-panel-fs-sidebar-meta,13px) text-destructive">{error}</p> : null}
    </section>
  );
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
