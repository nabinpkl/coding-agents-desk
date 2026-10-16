import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@/app/styles.css";
import { App } from "@/app/AgentPanelApp";
import { PanelErrorBoundary } from "@/app/PanelErrorBoundary";
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
import { installPanelTelemetry, panelRootOptions } from "@/features/telemetry/panelTelemetry";
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

// First, so the page-load trace starts before anything it measures. Not under a fixture or a native
// container: neither has the sidecar's `/api` to send telemetry to.
if (!isFixtureMode() && !hasNativeHost()) installPanelTelemetry();

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
  createRoot(root, panelRootOptions).render(
    <StrictMode>
      <PanelErrorBoundary surface="IDE">
        <WorkspaceIdeSurface transport={transport} feed={new SidecarDataSource(transport)} />
      </PanelErrorBoundary>
    </StrictMode>,
  );
} else if (entry === "desktop") {
  // The desktop entry is served from the host's live HTTPS origin and talks to that origin's
  // authenticated `/api` proxy. It deliberately has no native message transport: Swift chooses
  // the entry and owns visibility, while the page owns every desktop and pointer concern.
  const transport: AgentHttpTransport = new FetchHttpTransport();
  createRoot(root, panelRootOptions).render(
    <StrictMode>
      <PanelErrorBoundary surface="desktop viewer">
        <DesktopViewer transport={transport} />
      </PanelErrorBoundary>
    </StrictMode>,
  );
} else {
  const bridge = new WebkitHostBridge();
  const host = new HostActionsClient(bridge);
  const panel = createRoot(root, panelRootOptions);

  // No `window.__agentFeedBridge`: it existed only to re-issue the composer's watches after a
  // reconnect, and those are relayed subscriptions now (ADR-0110) -- a relayed subscription that
  // dies fails its request and the panel re-opens it. WebPanelKit's call is guarded by a typeof
  // check, so its absence is a no-op rather than an error.

  // A native container chooses its surface and owns visibility, so it is handed that surface and
  // nothing else. A browser tab has no chooser, so it gets both behind a tab bar and opens on the
  // desktop viewer: the feed is reachable from every shell, the desktop from none of them.
  const renderPanel = (transport: AgentHttpTransport, feed: SidecarDataSource): void => {
    panel.render(
      <StrictMode>
        <PanelErrorBoundary surface="panel">
          {hasNativeHost() ? (
            <App feed={feed} host={host} />
          ) : (
            <BrowserSurfaces transport={transport} feed={feed} host={host} />
          )}
        </PanelErrorBoundary>
      </StrictMode>,
    );
  };
  const transport: AgentHttpTransport = hasNativeHost()
    ? new RelayHttpTransport(bridge)
    : new FetchHttpTransport();
  renderPanel(transport, new SidecarDataSource(transport));

  // An edit to the data source, its layers or the transport -- or to the wire beneath them --
  // builds both afresh and hands them to the tree that is already mounted, rather than reloading
  // the page. Nothing unmounts: every effect keyed on the feed reopens its stream with the new
  // code, so it looks exactly like a sidecar restart (each surface keeps what it had and says it
  // is reconnecting), where a reload threw away every card's scroll, terminal and loaded history
  // and fetched every module again -- eight seconds on a phone. These are the modules this file
  // creates instances of; everything else under it is a component, which updates itself.
  //
  // Not under a native container, whose relay transport attaches to the one bridge and would need
  // detaching first, and not under the fixture, whose routes are installed once at startup: both
  // reload as before. The fixture is listed so that, outside fixture mode, a wire edit that reaches
  // it does not reload the page for a module that was never installed.
  if (import.meta.hot) {
    let build = { SidecarDataSource, FetchHttpTransport };
    import.meta.hot.accept(
      [
        "@/features/activity-feed/data-source/SidecarDataSource",
        "@/features/activity-feed/transport/AgentHttpTransport",
        "@/app/fake-sidecar/fixture",
      ],
      ([nextDataSource, nextTransport]) => {
        if (hasNativeHost() || isFixtureMode()) {
          import.meta.hot?.invalidate("the panel's data source changed under a native container or the fixture");
          return;
        }
        if (!nextDataSource && !nextTransport) return;
        build = {
          SidecarDataSource: (nextDataSource as typeof import("@/features/activity-feed/data-source/SidecarDataSource") | undefined)
            ?.SidecarDataSource ?? build.SidecarDataSource,
          FetchHttpTransport: (nextTransport as typeof import("@/features/activity-feed/transport/AgentHttpTransport") | undefined)
            ?.FetchHttpTransport ?? build.FetchHttpTransport,
        };
        const next = new build.FetchHttpTransport();
        renderPanel(next, new build.SidecarDataSource(next));
      },
    );
  }

  // The feed's surfaces all put something at the bottom of the screen -- the composer, and the
  // terminal band above it -- which is exactly what a phone keyboard covers. It lands as a
  // document height (styles.css), so it lifts whatever chains its height through `#root`; that is
  // the browser surfaces, which is where both live surfaces are.
  let keyboard = installKeyboardInset();

  // pagehide fires reliably in WKWebView (unload is often skipped under the
  // back-forward cache and on iOS); use it to tear down the host client.
  let lifecycle = installPagehideLifecycle(host);

  // Inert title-bar presses drag the native window. No-ops unless the Mac host installed its
  // window-chrome entry point, so the iOS client and a plain browser take no branch.
  let drag = installWindowDrag();

  // Each of these listens on the page itself, once, so an edit to one used to reload every panel to
  // install it again. Taking the old listeners off and installing from the new module does the same
  // thing in place, and nothing they own outlives the swap: each one's state is the listener.
  if (import.meta.hot) {
    import.meta.hot.accept(
      ["@/app/page/keyboardInset", "@/app/page/pageLifecycle", "@/app/page/windowDrag"],
      ([nextKeyboard, nextLifecycle, nextDrag]) => {
        if (nextKeyboard) {
          keyboard.remove();
          keyboard = (nextKeyboard as typeof import("@/app/page/keyboardInset")).installKeyboardInset();
        }
        if (nextLifecycle) {
          lifecycle.remove();
          lifecycle = (nextLifecycle as typeof import("@/app/page/pageLifecycle")).installPagehideLifecycle(host);
        }
        if (nextDrag) {
          drag.remove();
          drag = (nextDrag as typeof import("@/app/page/windowDrag")).installWindowDrag();
        }
      },
    );
  }
}
