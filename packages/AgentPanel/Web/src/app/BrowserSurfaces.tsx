import { useCallback, useEffect, useState } from "react";
import { App } from "./AgentPanelApp";
import { DesktopViewer } from "../features/desktop-viewer/DesktopViewer";
import { ScreenViewer } from "../features/screen-viewer/ScreenViewer";
import { TerminalsSurface } from "../features/terminal/TerminalsSurface";
import type { SidecarDataSource } from "../features/activity-feed/data-source/SidecarDataSource";
import type { HostActionsClient } from "../features/activity-feed/data-source/HostActionsClient";
import type { AgentHttpTransport } from "../features/activity-feed/transport/AgentHttpTransport";
import { sessionTransport } from "../features/activity-feed/transport/SessionTransport";
import { parseSessionIndex, type PanelSessionRef } from "./panelSessions";

export type BrowserSurface = "desktop" | "feed" | "screen" | "terminals";

const SURFACES: { readonly name: BrowserSurface; readonly label: string }[] = [
  { name: "desktop", label: "Desktop" },
  { name: "feed", label: "Feed" },
  { name: "screen", label: "Screen" },
  { name: "terminals", label: "Terminals" },
];

const NAMED = new Set<string>(SURFACES.map((surface) => surface.name));

/**
 * Which surface a plain browser opens on.
 *
 * The desktop viewer is the default, which is the opposite of every native container: a shell opens
 * the webview it wants, so the feed is reachable from anywhere, while the desktop was reachable from
 * nowhere but inside the iOS app. `?entry=` asks for another, and the value is the same vocabulary
 * `panelEntry` reads, so one parameter means one thing everywhere.
 */
export function initialSurface(search: string = window.location.search): BrowserSurface {
  const asked = new URLSearchParams(search).get("entry") ?? "";
  return NAMED.has(asked) ? (asked as BrowserSurface) : "desktop";
}

/**
 * The login sessions this origin can reach, or none when it does not say.
 *
 * An origin that serves no index is one that proxies a single sidecar, which is every origin until
 * a second session is configured, and is also what the host's webview looks like. No index means no
 * picker, and the viewer behaves exactly as it did before there was such a thing.
 */
function useSessions(): PanelSessionRef[] {
  const [sessions, setSessions] = useState<PanelSessionRef[]>([]);
  useEffect(() => {
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
  }, []);
  return sessions;
}

const SESSION_STORAGE_KEY = "agentdesk.panel.session";
/** Matches the ids the server will route; a hand-edited value must not reshape a path. */
const SESSION_ID = /^[a-z0-9-]+$/i;

/**
 * The session this panel was last showing, restored optimistically.
 *
 * Optimistic because the live list arrives over the stream a moment later, and waiting for it would
 * open every reload on the default session and then jump. If the remembered session turns out not
 * to be running, `BrowserSurfaces` drops back to the default once the list says so.
 */
export function rememberedSession(): string | undefined {
  try {
    const stored = localStorage.getItem(SESSION_STORAGE_KEY);
    return stored && SESSION_ID.test(stored) ? stored : undefined;
  } catch {
    return undefined;
  }
}

/** Keeps the address bar honest, so a reload returns to the surface you were on. */
function remember(surface: BrowserSurface): void {
  const url = new URL(window.location.href);
  url.searchParams.set("entry", surface);
  window.history.replaceState(null, "", url);
}

/**
 * Both panel surfaces behind one tab bar, for the browser leg only.
 *
 * Only the selected surface is mounted. Leaving the viewer mounted while hidden would hold a live
 * WebRTC track and its encoder open behind the feed, which costs bitrate and an encoder process for
 * a picture nobody is looking at; the price is that returning to the desktop renegotiates rather
 * than resumes.
 */
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
    try {
      if (next) localStorage.setItem(SESSION_STORAGE_KEY, next);
      else localStorage.removeItem(SESSION_STORAGE_KEY);
    } catch {
      // a private window still gets the choice for this session
    }
  }, []);
  // A remembered session that is no longer announced would proxy to nothing, so fall back once the
  // live list has actually arrived. An empty list means "not known yet", not "gone".
  useEffect(() => {
    if (sessionId === undefined || sessions.length === 0) return;
    if (!sessions.some((session) => session.id === sessionId)) selectSession(undefined);
  }, [sessionId, sessions, selectSession]);

  function select(next: BrowserSurface): void {
    if (next === surface) return;
    remember(next);
    setSurface(next);
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        role="tablist"
        aria-label="Panel surfaces"
        className="flex shrink-0 gap-3 border-b border-border bg-background px-3"
      >
        {SURFACES.map(({ name, label }) => (
          <button
            key={name}
            type="button"
            role="tab"
            aria-selected={surface === name}
            tabIndex={surface === name ? 0 : -1}
            onClick={() => select(name)}
            className={`flex min-h-11 items-center border-b-2 px-2 text-(length:--agent-panel-fs-sidebar-title,15px) font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset active:bg-muted/70 ${
              surface === name
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:bg-muted/60 hover:text-foreground"
            }`}
          >
            {label}
          </button>
        ))}
        {/* The picker rides with the desktop only. The feed reads whatever sessions the sidecar it
            was built against can see, and moving it would mean rebuilding its data source, which is
            a larger change than switching a video stream. */}
        {surface === "desktop" && sessions.length > 1 ? (
          <div
            role="group"
            aria-label="Desktop session"
            className="ml-auto flex items-center gap-1 self-center"
          >
            {sessions.map((session) => (
              <button
                key={session.id ?? "default"}
                type="button"
                aria-pressed={session.id === sessionId}
                onClick={() => selectSession(session.id)}
                className={`rounded-md px-2 py-1 text-(length:--agent-panel-fs-sidebar-meta,13px) font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary ${
                  session.id === sessionId
                    ? "bg-muted text-foreground"
                    : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                }`}
              >
                {session.label}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      <div className="min-h-0 flex-1">
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
        ) : surface === "terminals" ? (
          <TerminalsSurface feed={feed} />
        ) : (
          <App feed={feed} host={host} fill />
        )}
      </div>
    </div>
  );
}
