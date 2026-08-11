import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { App } from "./AgentPanelApp";
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

declare global {
  interface Window {
    /** Set by the native container (or a test) to force host-free fixture mode. */
    __agentFeedFixture?: boolean;
    __agentFeedBridge?: {
      resumeAfterSessionReconnect(): void;
    };
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
const bridge = new WebkitHostBridge();
const transport: AgentHttpTransport = hasNativeHost()
  ? new RelayHttpTransport(bridge)
  : new FetchHttpTransport();
const feed = new SidecarDataSource(transport);
const host = new HostActionsClient(bridge);

window.__agentFeedBridge = {
  resumeAfterSessionReconnect: () => host.resumeAfterSessionReconnect(),
};

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

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
