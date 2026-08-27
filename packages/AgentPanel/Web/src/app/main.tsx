import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { App } from "./AgentPanelApp";
import { panelEntry } from "./panelEntry";
import { SidecarDataSource } from "../features/activity-feed/data-source/SidecarDataSource";
import { HostActionsClient } from "../features/activity-feed/data-source/HostActionsClient";
import { WebkitHostBridge } from "../features/activity-feed/data-source/HostBridge";
import {
  FetchHttpTransport,
  RelayHttpTransport,
  type AgentHttpTransport,
} from "../features/activity-feed/transport/AgentHttpTransport";
import { installFixture } from "./fixture";
import { installPagehideLifecycle } from "./pageLifecycle";
import { installWindowDrag } from "./windowDrag";
import { DesktopViewer } from "../features/desktop-viewer/DesktopViewer";

declare global {
  interface Window {
    /** Set by the native container (or a test) to force host-free fixture mode. */
    __agentFeedFixture?: boolean;
    /** Selects a first-party page entry before React mounts. */
    __agentPanelEntry?: "feed" | "desktop";
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

if (panelEntry() === "desktop") {
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

  createRoot(root).render(
    <StrictMode>
      <App feed={feed} host={host} />
    </StrictMode>,
  );

  // pagehide fires reliably in WKWebView (unload is often skipped under the
  // back-forward cache and on iOS); use it to tear down the host client.
  installPagehideLifecycle(host);

  // Inert title-bar presses drag the native window. No-ops unless the Mac host installed its
  // window-chrome entry point, so the iOS client and a plain browser take no branch.
  installWindowDrag();
}
