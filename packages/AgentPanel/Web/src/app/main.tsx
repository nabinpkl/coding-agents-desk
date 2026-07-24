import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { App } from "./AgentPanelApp";
import { BridgeDataSource } from "../features/activity-feed/data-source/BridgeDataSource";
import { WebkitHostBridge } from "../features/activity-feed/data-source/HostBridge";
import { installFixture } from "./fixture";
import { installPagehideLifecycle } from "./pageLifecycle";

declare global {
  interface Window {
    /** Set by the native container (or a test) to force host-free fixture mode. */
    __agentFeedFixture?: boolean;
  }
}

/** Whether to run in fixture (host-free) mode. */
function isFixtureMode(): boolean {
  if (window.__agentFeedFixture === true) return true;
  return new URLSearchParams(window.location.search).has("fixture");
}

const bridge = new BridgeDataSource(new WebkitHostBridge());

if (isFixtureMode()) {
  // Install the fixture before mounting so the bridge's global deliver
  // function is in place before any component calls subscribeProjects.
  installFixture();
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

createRoot(root).render(
  <StrictMode>
    <App bridge={bridge} />
  </StrictMode>,
);

// pagehide fires reliably in WKWebView (unload is often skipped under the
// back-forward cache and on iOS); use it to tear down the bridge.
installPagehideLifecycle(bridge);
