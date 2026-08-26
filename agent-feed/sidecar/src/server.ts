import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import type { SidecarConfig } from "@agentdesk/agent-feed-wire";
import { config } from "./config.ts";
import {
  BYE_BYTES,
  jsonResponse,
} from "./http/httpResponses.ts";
import { authorizeApiRequest } from "./http/auth.ts";
import { createAgentRoutes } from "./http/agentRoutes.ts";
import { createCliInputRoutes } from "./http/cliInputRoutes.ts";
import { createInventoryRoutes } from "./http/inventoryRoutes.ts";
import { createParkRoutes } from "./http/parkRoutes.ts";
import { createTileRoutes } from "./http/tileRoutes.ts";
import type { RouteHandler } from "./http/route.ts";
import { createSessionRoutes } from "./http/sessionRoutes.ts";
import { createSummaryRoutes } from "./http/summaryRoutes.ts";
import { createTaskRoutes } from "./http/taskRoutes.ts";
import { createTimelineRoutes } from "./http/timelineRoutes.ts";
import { createUsageRoutes } from "./http/usageRoutes.ts";
import { detectUsageVendors } from "./usage/usageReport.ts";
import { state } from "./transcripts/transcriptState.ts";
import {
  getSnapshot,
  getWatcherState,
  startCatalog,
  stopCatalog,
  registerPiSession,
  resolvePiSession,
  notifyPiSessionChanged,
} from "./transcripts/transcriptCatalog.ts";
import { AgentBackendRegistry } from "./agents/agentBackend.ts";
import { PiAgentBackend } from "./agents/piAgentBackend.ts";
import { ClaudeLiveBackend } from "./live/claudeLiveBackend.ts";
import { CodexLiveBackend } from "./live/codexLiveBackend.ts";

// Pi normally lazy-loads OAuth providers from sibling files. A standalone Bun
// executable has no such files beside it, so use Pi's static loader registry to
// make every supported OAuth implementation part of the compiled sidecar.
registerBunOAuthFlows();

const backends = new AgentBackendRegistry();
backends.register(new PiAgentBackend({
  resolveSession: resolvePiSession,
  onSessionCreated: registerPiSession,
  onSessionChanged: notifyPiSessionChanged,
}));
// Read-only live mirror of Claude Code traffic observed through proxy-agent.
// Registered unconditionally so its routes answer with a precise "unknown
// source" when the observer endpoint is unreachable; `start()` degrades to a
// quiet no-op when disabled.
const claudeLive = new ClaudeLiveBackend();
backends.register(claudeLive);
// Read-only live mirror of Codex Desktop traffic observed through proxy-agent,
// with the same registration contract as the claude live mirror.
const codexLive = new CodexLiveBackend();
backends.register(codexLive);
const resolveBackend = (id: string) => backends.get(id);
const describeAgentSession = (source: string, sessionId: string) =>
  backends.get(source)?.describeSession(sessionId);
const routes: RouteHandler[] = [
  createInventoryRoutes(describeAgentSession),
  createAgentRoutes(resolveBackend),
  // Ahead of the session routes so `/timeline` is matched before their
  // catch-all rejection of unknown `/api/sessions/` paths.
  createTimelineRoutes(resolveBackend, describeAgentSession),
  // Ahead of them for the same reason: `/tasks` and `/tasks/<id>/output` live under
  // `/api/sessions/` and would otherwise be rejected before they are matched.
  createTaskRoutes(),
  // And again: `/input` is under `/api/sessions/` too.
  createCliInputRoutes(),
  // Same reason again: `/summary` lives under `/api/sessions/`.
  createSummaryRoutes(resolveBackend, describeAgentSession),
  // Not under `/api/sessions/` at all -- usage is a fact about the machine -- so its position
  // here is only for readability.
  createUsageRoutes(),
  // Same: a Desktop belongs to the machine, not to a thread.
  createParkRoutes(),
  createTileRoutes(),
  createSessionRoutes(describeAgentSession),
];
const SHUTDOWN_GRACE_MS = 500;

const server = Bun.serve<undefined>({
  hostname: config.host,
  port: config.port,
  // Bun closes an idle connection after 10 seconds by default, and it counts a
  // streaming response as idle. Every long-lived surface here outlives that: the
  // timeline and task SSE streams, and the tile stream, which is a video that is
  // supposed to run for as long as someone is watching. Left at the default it
  // hangs up at exactly ten seconds and the page sees a bare 500 with no body.
  // 0 disables it; the sidecar is a loopback service and its clients are the
  // panel and the host.
  idleTimeout: 0,
  fetch(request, bunServer) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      const denied = authorizeApiRequest(request, config.controlToken);
      if (denied) return denied;
    }
    if (request.method === "GET" && url.pathname === "/api/config") {
      const body: SidecarConfig = {
        staleThresholdMs: config.staleThresholdMs,
        readyThresholdMs: config.readyThresholdMs,
        liveWindowMs: config.liveWindowMs,
        watcherState: getWatcherState(),
        sessionCount: getSnapshot().length,
        // Whether the panel should offer the Summarize button. A process-global fact, so it
        // lives here rather than being copied identically onto every session's capabilities.
        summaryEnabled: config.summaryEnabled,
        summaryModel: config.summaryEnabled ? `${config.summaryProvider}/${config.summaryModel}` : null,
        // Recomputed per request rather than at startup: a machine that installs Codex while the
        // host is running should offer the surface without a relaunch, and the check is one
        // `existsSync`.
        usageVendors: detectUsageVendors(),
        // Whether this machine can gather windows onto one Desktop. Carried here
        // rather than probed by the panel: the relay admits only a few concurrent
        // requests per surface, and an extra availability call fired on mount
        // loses that race and reads as "this machine cannot do it".
        parkAvailable: config.yabaiPath !== null,
      };
      return jsonResponse(body);
    }
    for (const route of routes) {
      const response = route(request, url, bunServer);
      if (response !== undefined) return response;
    }
    return new Response("not found", {
      status: 404,
    });
  },
});

console.log(`agent feed sidecar listening on http://${config.host}:${server.port}`);
void startCatalog()
  .then(async () => {
    await claudeLive.start();
    await codexLive.start();
  })
  .catch((error) => {
    console.error("agent feed catalog startup failed", error);
    server.stop(true);
    process.exit(1);
  });

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  state.shuttingDown = true;
  console.log(
    `agent feed sidecar ${signal}: draining ${state.openStreams.size} stream(s)`,
  );
  for (const stream of [...state.openStreams]) {
    try {
      stream.controller.enqueue(BYE_BYTES);
    } catch (error) {
      console.debug("agent feed stream closed before shutdown notice", error);
      stream.teardown();
    }
  }
  await Bun.sleep(SHUTDOWN_GRACE_MS);
  for (const stream of [...state.openStreams]) stream.teardown();
  await stopCatalog();
  try {
    await backends.dispose();
  } catch (error) {
    console.error("agent backend shutdown failed", error);
  }
  server.stop(true);
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
