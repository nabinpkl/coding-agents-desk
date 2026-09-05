import { useState } from "react";
import { App } from "./AgentPanelApp";
import { DesktopViewer } from "../features/desktop-viewer/DesktopViewer";
import type { SidecarDataSource } from "../features/activity-feed/data-source/SidecarDataSource";
import type { HostActionsClient } from "../features/activity-feed/data-source/HostActionsClient";
import type { AgentHttpTransport } from "../features/activity-feed/transport/AgentHttpTransport";

export type BrowserSurface = "desktop" | "feed";

const SURFACES: { readonly name: BrowserSurface; readonly label: string }[] = [
  { name: "desktop", label: "Desktop" },
  { name: "feed", label: "Feed" },
];

/**
 * Which surface a plain browser opens on.
 *
 * The desktop viewer is the default here, which is the opposite of every native container: a shell
 * opens the webview it wants, so the feed is reachable from anywhere, while the desktop was
 * reachable from nowhere but inside the iOS app. `?entry=feed` asks for the other one, and the
 * value is the same vocabulary `panelEntry` reads, so one parameter means one thing everywhere.
 */
export function initialSurface(search: string = window.location.search): BrowserSurface {
  return new URLSearchParams(search).get("entry") === "feed" ? "feed" : "desktop";
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
      </div>
      <div className="min-h-0 flex-1">
        {surface === "desktop" ? (
          <DesktopViewer transport={transport} />
        ) : (
          <App feed={feed} host={host} fill />
        )}
      </div>
    </div>
  );
}
