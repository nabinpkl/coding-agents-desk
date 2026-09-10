import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@/app/styles.css";
import { App } from "@/app/AgentPanelApp";
import { panelEntry } from "@/app/page/panelEntry";
import { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import { HostActionsClient } from "@/features/activity-feed/data-source/HostActionsClient";
import { WebkitHostBridge } from "@/features/activity-feed/data-source/HostBridge";
import {
  FetchHttpTransport,
  RelayHttpTransport,
  type AgentHttpTransport,
} from "@/features/activity-feed/transport/AgentHttpTransport";
import { installFixture } from "@/app/fake-sidecar/fixture";
import { installKeyboardInset } from "@/app/page/keyboardInset";
import { installPagehideLifecycle } from "@/app/page/pageLifecycle";
import { installWindowDrag } from "@/app/page/windowDrag";
import { DesktopViewer } from "@/features/desktop-viewer/DesktopViewer";
import { BrowserSurfaces } from "@/app/BrowserSurfaces";
import { WorkspaceIdeSurface } from "@/features/workspace-ide/WorkspaceIdeSurface";

declare global {
  interface Window {
    /** Set by the native container (or a test) to force host-free fixture mode. */
    __agentFeedFixture?: boolean;
    /** Selects a first-party page entry before React mounts. */
    __agentPanelEntry?: "feed" | "desktop" | "ide";
  }
}

/** Whether to run in fixture (host-free) mode. */
function isFixtureMode(): boolean {
  if (window.__agentFeedFixture === true) return true;
  return new URLSearchParams(window.location.search).has("fixture");
}

/**
 * Whether a native container is behind this page.
 *
 * Decided by the presence of the message handler, not by the page's origin: the dev server serves
 * the same bundle to both a browser tab and the host's webview, and only the webview has a relay
 * to talk to.
 */
function hasNativeHost(): boolean {
  return window.webkit?.messageHandlers?.agentFeed !== undefined;
}

// Before the transport, because the fixture installs the message handler the transport chooses by.
if (isFixtureMode()) installFixture();

// One bridge, shared. The host pushes relayed HTTP frames and native-authority replies down the
// same channel, so a second delivery global would mean whichever module installed it first
// swallowed the other's messages.
const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

const entry = panelEntry();

if (entry === "ide") {
  // The workspace IDE, filling a container that asked for it -- today the `＋ IDE` window, which
  // declares `window.__agentPanelEntry` in a user script the way the iOS shell declares `desktop`
  // (ADR-0115). Like the desktop entry it takes no native message transport: it talks to the
  // origin's `/api` proxy, because its whole backend is the sidecar. A browser tab reaches the
  // same surface through the tab bar instead, so this branch is never the browser's.
  const transport: AgentHttpTransport = new FetchHttpTransport();
  createRoot(root).render(
    <StrictMode>
      <WorkspaceIdeSurface transport={transport} feed={new SidecarDataSource(transport)} />
    </StrictMode>,
  );
} else if (entry === "desktop") {
  // The desktop entry is served from the host's live HTTPS origin and talks to that origin's
  // authenticated `/api` proxy. It deliberately has no native message transport: Swift chooses
  // the entry and owns visibility, while the page owns every desktop and pointer concern.
  const transport: AgentHttpTransport = new FetchHttpTransport();
  createRoot(root).render(
    <StrictMode>
      <DesktopViewer transport={transport} />
    </StrictMode>,
  );
} else {
  const bridge = new WebkitHostBridge();
  const transport: AgentHttpTransport = hasNativeHost()
    ? new RelayHttpTransport(bridge)
    : new FetchHttpTransport();
  const feed = new SidecarDataSource(transport);
  const host = new HostActionsClient(bridge);

  // No `window.__agentFeedBridge`: it existed only to re-issue the composer's watches after a
  // reconnect, and those are relayed subscriptions now (ADR-0110) -- a relayed subscription that
  // dies fails its request and the panel re-opens it. WebPanelKit's call is guarded by a typeof
  // check, so its absence is a no-op rather than an error.

  // A native container chooses its surface and owns visibility, so it is handed that surface and
  // nothing else. A browser tab has no chooser, so it gets both behind a tab bar and opens on the
  // desktop viewer: the feed is reachable from every shell, the desktop from none of them.
  createRoot(root).render(
    <StrictMode>
      {hasNativeHost() ? (
        <App feed={feed} host={host} />
      ) : (
        <BrowserSurfaces transport={transport} feed={feed} host={host} />
      )}
    </StrictMode>,
  );

  // The feed's surfaces all put something at the bottom of the screen -- the composer, and the
  // terminal band above it -- which is exactly what a phone keyboard covers. It lands as a
  // document height (styles.css), so it lifts whatever chains its height through `#root`; that is
  // the browser surfaces, which is where both live surfaces are.
  installKeyboardInset();

  // pagehide fires reliably in WKWebView (unload is often skipped under the
  // back-forward cache and on iOS); use it to tear down the host client.
  installPagehideLifecycle(host);

  // Inert title-bar presses drag the native window. No-ops unless the Mac host installed its
  // window-chrome entry point, so the iOS client and a plain browser take no branch.
  installWindowDrag();
}
