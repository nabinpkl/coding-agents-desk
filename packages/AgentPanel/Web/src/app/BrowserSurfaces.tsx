import { SquareTerminal } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { App } from "@/app/AgentPanelApp";
import { PanelErrorBoundary } from "@/app/PanelErrorBoundary";
import { FatherScope } from "@/features/bots/father/FatherScope";
import { DesktopViewer } from "@/features/desktop-viewer/DesktopViewer";
import { TypeSettings } from "@/features/appearance/TypeSettings";
import { FatherButton } from "@/features/bots/canvas/FatherOverlay";
import { loadFatherOpen, storeFatherOpen } from "@/features/bots/canvas/fatherPreferences";
import { ScreenViewer } from "@/features/screen-viewer/ScreenViewer";
import { TerminalCanvasShell } from "@/features/terminal/canvas/TerminalCanvasShell";
import {
  MachineTerminalDialog,
  type MachineTerminalTarget,
} from "@/features/terminal/MachineTerminalDialog";
import { WorkspaceIdeSurface } from "@/features/workspace-ide/WorkspaceIdeSurface";
import { ArenaSurface } from "@/features/arena/ArenaSurface";
import { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import type { HostActionsClient } from "@/features/activity-feed/data-source/HostActionsClient";
import type { AgentHttpTransport } from "@/features/activity-feed/transport/AgentHttpTransport";
import { sessionTransport } from "@/features/activity-feed/transport/SessionTransport";
import { parseSessionIndex, type PanelSessionRef } from "@/app/panelSessions";
import {
  initialSurface,
  rememberedSession,
  rememberSurface,
  storeSession,
  SURFACES,
  type BrowserSurface,
} from "@/app/page/browserSurface";
import { useSubscription } from "@/hooks/useSubscription";
import { useSidecarConfig } from "@/query/sidecarConfig";

/**
 * The login sessions this origin can reach, or none when it does not say.
 *
 * An origin that serves no index is one that proxies a single sidecar, which is every origin until
 * a second session is configured, and is also what the host's webview looks like. No index means no
 * picker, and the viewer behaves exactly as it did before there was such a thing.
 */
function useSessions(): PanelSessionRef[] {
  const [sessions, setSessions] = useState<PanelSessionRef[]>([]);
  useSubscription("panel-sessions", () => {
    // Subscribe, do not poll: the dev server pushes the live set whenever a sidecar announces itself
    // or goes silent, so a desktop that comes up while the page is open appears in the picker on its
    // own. The stream sends the current set on connect and reconnects itself if it drops, so this is
    // both the initial load and the live update. A one-shot fetch is the fallback for a transport
    // that cannot open an EventSource at all.
    const apply = (value: unknown) => setSessions(parseSessionIndex(value));
    let source: EventSource | undefined;
    const abort = new AbortController();
    try {
      source = new EventSource("/session/stream");
      source.onmessage = (event) => {
        try {
          apply(JSON.parse(event.data));
        } catch {
          // keep the last good set rather than blanking the picker on one bad frame
        }
      };
    } catch {
      fetch("/session/index.json", { signal: abort.signal })
        .then((response) => (response.ok ? response.json() : Promise.reject(new Error(String(response.status)))))
        .then(apply)
        .catch(() => undefined);
    }
    return () => {
      source?.close();
      abort.abort();
    };
  });
  return sessions;
}

/**
 * Both panel surfaces behind one tab bar, for the browser leg only.
 *
 * Only the selected surface is mounted. Leaving the viewer mounted while hidden would hold a live
 * WebRTC track and its encoder open behind the feed, which costs bitrate and an encoder process for
 * a picture nobody is looking at; the price is that returning to the desktop renegotiates rather
 * than resumes.
 */
/**
 * Whether the selected sidecar has a Mac desktop behind it at all.
 *
 * A peer on another machine has no display to capture and no window manager to ask, so Desktop and
 * Screen would fail rather than degrade. `/api/config` already answers this as `parkAvailable`
 * (the sidecar sets it from `yabaiPath !== null`), so it is read rather than a new field invented
 * for the question. Unknown counts as yes, so the local session never flickers a tab away while the
 * config request is in flight, and an unreachable peer keeps whatever it had rather than losing
 * tabs to one failed request.
 */
function useDesktopAvailable(feed: SidecarDataSource): boolean {
  // A failed read leaves the tabs as they are: a blip is not evidence that the desktop is gone.
  const config = useSidecarConfig(feed).data;
  const available = config === undefined ? true : config.parkAvailable === true;
  return available;
}

export function BrowserSurfaces({
  transport,
  feed,
  host,
}: {
  transport: AgentHttpTransport;
  feed: SidecarDataSource;
  host: HostActionsClient;
}) {
  const [surface, setSurface] = useState<BrowserSurface>(initialSurface);
  const sessions = useSessions();
  // undefined is the default session, the one this origin proxies on `/api`.
  const [sessionId, setSessionId] = useState<string | undefined>(rememberedSession);
  const selectSession = useCallback((next: string | undefined) => {
    setSessionId(next);
    storeSession(next);
  }, []);
  // A remembered session that is no longer announced would proxy to nothing, so fall back once the
  // live list has actually arrived. An empty list means "not known yet", not "gone".
  if (sessionId !== undefined && sessions.length > 0 && !sessions.some((session) => session.id === sessionId)) {
    selectSession(undefined);
  }

  /**
   * One data source per session, built once and kept.
   *
   * Cached rather than rebuilt, because the live index pushes whenever any peer's heartbeat comes
   * or goes, and a source rebuilt on that beat would tear down and reopen every subscription behind
   * it -- including this machine's, for a change on another machine entirely. Keyed on `transport`
   * so the cache cannot outlive the thing it wraps.
   */
  const sources = useMemo(() => new Map<string, SidecarDataSource>(), [transport]);
  const sourceFor = useCallback(
    (id: string | undefined): SidecarDataSource => {
      // The default session keeps the source built at startup, which keeps the native/webview leg
      // bit-for-bit what it was.
      if (!id) return feed;
      const existing = sources.get(id);
      if (existing) return existing;
      const made = new SidecarDataSource(sessionTransport(transport, id));
      sources.set(id, made);
      return made;
    },
    [feed, sources, transport],
  );

  /**
   * The data source for whichever session is selected.
   *
   * The picker used to move the desktop alone, because the feed's data source was built once at
   * startup and pointing it elsewhere meant rebuilding it. That is all this is: one source per
   * session, so the feed and the terminals answer the picker too.
   */
  const sessionFeed = useMemo(() => sourceFor(sessionId), [sourceFor, sessionId]);

  /**
   * Every machine the Bot canvas reads, which is every session this origin can reach.
   *
   * The picker scopes the whole panel to ONE session; the canvas is the exception, because a Bot is
   * a directory and the sessions working in it, and those directories are not all on this Mac. A
   * peer declared with `AGENTDESK_PANEL_REMOTE_SIDECARS` and served by `tools/remote-sidecar.sh`
   * shows its Bots beside this machine's, each card acting on the sidecar that owns it. See
   * `features/bots/botMachines.ts`.
   *
   * Built from the same live index the picker uses, so a machine that goes quiet leaves both at
   * once and there is never a card for a peer the picker says is gone.
   */
  const machines = useMemo(
    () => sessions.map((session) => ({
      ...(session.id === undefined ? {} : { id: session.id }),
      label: session.label,
      feed: sourceFor(session.id),
    })),
    [sessions, sourceFor],
  );
  const desktopAvailable = useDesktopAvailable(sessionFeed);
  // A peer with no desktop must not leave the page sitting on a surface it cannot serve.
  const visible = SURFACES.filter(
    ({ name }) => desktopAvailable || (name !== "desktop" && name !== "screen"),
  );
  if (!desktopAvailable && (surface === "desktop" || surface === "screen")) {
    rememberSurface("feed");
    setSurface("feed");
  }

  // Which machine's shell is open over the surface, if any. React state rather than stored: the
  // dialog ends its shell when it is closed, so a reload that forgets it forgets nothing running.
  const [terminalMachine, setTerminalMachine] = useState<MachineTerminalTarget | null>(null);
  const selectedLabel = sessions.find((session) => session.id === sessionId)?.label ?? "this machine";
  // The Father home's switch, owned here because its place is in this bar rather than in any one
  // view. Stored, so the drawer it opens over agrees with the bar about whether it is open. On
  // every tab: elsewhere the drawer it opens stands over the feed's roster, so the press goes
  // to the feed first and then opens.
  const [fatherOpen, setFatherOpen] = useState(loadFatherOpen);
  const writeFatherOpen = useCallback((next: boolean) => {
    setFatherOpen(next);
    storeFatherOpen(next);
  }, []);
  const toggleFather = useCallback(() => {
    setFatherOpen((was) => {
      const next = !was;
      storeFatherOpen(next);
      return next;
    });
  }, []);
  function select(next: BrowserSurface): void {
    if (next === surface) return;
    rememberSurface(next);
    setSurface(next);
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Scrolls sideways rather than compressing: on a phone the surfaces alone fill the width,
          and the session picker beyond them was simply off the screen -- a peer you could not
          reach and had no way of knowing was there. `ml-auto` on the picker still pushes it to the
          right wherever there IS room, because free space is what that margin eats.

          `overscroll-x-contain` so a swipe that runs out of bar stops there instead of becoming
          the browser's back gesture, which on iOS would leave the panel entirely. */}
      <div
        role="tablist"
        aria-label="Panel surfaces"
        className="flex shrink-0 gap-3 overflow-x-auto overscroll-x-contain border-b border-border bg-background px-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {visible.map(({ name, label }) => (
          <button
            key={name}
            type="button"
            role="tab"
            aria-selected={surface === name}
            tabIndex={surface === name ? 0 : -1}
            onClick={() => select(name)}
            className={`flex min-h-11 shrink-0 items-center whitespace-nowrap border-b-2 px-2 text-(length:--agent-panel-fs-sidebar-title,15px) font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset active:bg-muted/70 ${
              surface === name
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:bg-muted/60 hover:text-foreground"
            }`}
          >
            {label}
          </button>
        ))}
        {/* The picker rides with every surface that takes a data source. Screen is the exception:
            it reads this origin directly rather than a sidecar, so there is nothing to point.

            It no longer points EVERYTHING, and the name says so. The Bot canvas reads every machine
            at once -- a Bot is a directory and those are not all on one machine -- so this moves
            the session list, the open thread, the terminals, the IDE and the desktop, and leaves
            the canvas showing the lot. Called "session" before, which named neither the thing it
            switches nor the thing it does not; the sidebar's Canvas roster carries the other half
            of the sentence, a chip per machine with its count (`BotCanvasStatus`). */}
        {surface !== "screen" && sessions.length > 1 ? (
          <div
            role="group"
            aria-label="Machine for this panel"
            className="ml-auto flex shrink-0 items-center gap-1 self-center"
          >
            {sessions.map((session) => (
              <div key={session.id ?? "default"} className="flex shrink-0 items-center">
                <button
                  type="button"
                  aria-pressed={session.id === sessionId}
                  title={`Point the session list, terminals, IDE and desktop at ${session.label}. The Bot canvas keeps showing every machine.`}
                  onClick={() => selectSession(session.id)}
                  className={`shrink-0 whitespace-nowrap rounded-md px-2 py-1 text-(length:--agent-panel-fs-sidebar-meta,13px) font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary ${
                    session.id === sessionId
                      ? "bg-muted text-foreground"
                      : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                  }`}
                >
                  {session.label}
                </button>
                <MachineTerminalButton
                  label={session.label}
                  onOpen={() => setTerminalMachine({ label: session.label, feed: sourceFor(session.id) })}
                />
              </div>
            ))}
          </div>
        ) : (
          // No picker, so no row to sit beside: one button for the machine the panel is on.
          <div className="ml-auto flex shrink-0 items-center self-center">
            <MachineTerminalButton
              label={selectedLabel}
              onOpen={() => setTerminalMachine({ label: selectedLabel, feed: sessionFeed })}
            />
          </div>
        )}
        {/* Last in the bar, so it sits in the corner. The face and weight live behind this
            button rather than riding the bar beside it: two always-visible selects spent the
            corner on a choice most readers make once, and a control reached through one press
            still shows its effect on the page it is on. Above the tabs' own boundaries, so it
            carries one: the root's would take the tab bar with it. */}
        <PanelErrorBoundary surface="type settings" compact>
          <TypeSettings />
        </PanelErrorBoundary>
        {/* Right of the display settings, on every tab: the Father home's switch. */}
        <span className="flex shrink-0 items-center self-center">
          <FatherButton open={fatherOpen} onToggle={toggleFather} floating={false} />
        </span>
      </div>
      {terminalMachine ? (
        <PanelErrorBoundary surface="machine terminal" overlay onDismiss={() => setTerminalMachine(null)}>
          <MachineTerminalDialog machine={terminalMachine} onClose={() => setTerminalMachine(null)} />
        </PanelErrorBoundary>
      ) : null}
      {/* The site-wide Father home: bot records in, over every tab. Its switch is in the bar
          above; the drawer stands here so no surface owns it. */}
      <PanelErrorBoundary surface="Father home" overlay onDismiss={() => writeFatherOpen(false)}>
        <FatherScope
          feed={feed}
          host={host}
          machines={machines}
          open={fatherOpen}
          onClose={() => writeFatherOpen(false)}
        />
      </PanelErrorBoundary>
      <div className="min-h-0 flex-1">
        {/* Under the tab bar, not around it: a surface that throws must leave the tabs that lead
            away from it. Keyed by surface so moving to another tab starts it clean. */}
        <PanelErrorBoundary key={surface} surface={`${SURFACES.find((s) => s.name === surface)?.label ?? surface} tab`}>
          {surface === "desktop" ? (
            // Keyed by session so a switch tears the old viewer down. Its WebRTC track, its encoder
            // and its display selection all belong to the session that answered, and none of them
            // survive a move to another desktop.
            <DesktopViewer
              key={sessionId ?? "default"}
              scope={sessionId ?? "default"}
              transport={sessionTransport(transport, sessionId)}
            />
          ) : surface === "screen" ? (
            <ScreenViewer />
          ) : surface === "ide" ? (
            // Keyed by session for the same reason the others are: the workspace roster, the shared
            // open-tab state and every file it can reach belong to the sidecar that answered.
            <WorkspaceIdeSurface
              key={sessionId ?? "default"}
              transport={sessionTransport(transport, sessionId)}
              feed={sessionFeed}
            />
          ) : surface === "terminals" ? (
            // Keyed by session for the same reason the desktop is: the tmux attaches, the terminal
            // stream and every subscription belong to the sidecar that answered, and none of them
            // survive a move to another one. The canvas reads every machine at once the way the Bot
            // canvas does -- a tmux session is a directory and those are not all on one machine --
            // so this moves the picker-scoped feed and the whole index beside it.
            <TerminalCanvasShell
              key={sessionId ?? "default"}
              feed={sessionFeed}
              machines={machines}
            />
          ) : surface === "arena" ? (
            // Keyed by session for the same reason the others are: the runs, and the sessions each
            // contestant is, belong to the sidecar that answered -- a run started on one machine is
            // not a run on another, and the tab is not a view of a peer the picker left behind.
            <ArenaSurface
              key={sessionId ?? "default"}
              transport={sessionTransport(transport, sessionId)}
              feed={sessionFeed}
              host={host}
            />
          ) : (
            <App
              key={sessionId ?? "default"}
              feed={sessionFeed}
              host={host}
              machines={machines}
              fill
              fatherExternal
            />
          )}
        </PanelErrorBoundary>
      </div>
    </div>
  );
}

/**
 * Opens a login shell on one machine, beside that machine's name in the tab bar.
 *
 * Its own button rather than an item in a menu, because it is one action with a glyph every
 * terminal user reads on sight, and a menu would cost a second tap to reach the only thing in it.
 */
function MachineTerminalButton({ label, onOpen }: { label: string; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`Open a terminal on ${label}`}
      title={`Open a terminal on ${label}`}
      className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary active:bg-muted/80"
    >
      <SquareTerminal className="size-4" aria-hidden />
    </button>
  );
}
