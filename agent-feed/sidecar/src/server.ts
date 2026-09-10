import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import type { SidecarConfig } from "@agentdesk/agent-feed-wire";
import { config } from "@/config";
import { announceSidecar } from "@/sidecarRegistry";
import {
  BYE_BYTES,
  jsonResponse,
} from "@/http/httpResponses";
import { createAgentRoutes } from "@/http/agentRoutes";
import { createBotRoutes } from "@/http/botRoutes";
import { createCliInputRoutes } from "@/http/session-routes/cliInputRoutes";
import {
  createTmuxComposerRoutes,
  liveTmuxComposerDependencies,
} from "@/http/session-routes/tmuxComposerRoutes";
import { createInventoryRoutes } from "@/http/inventoryRoutes";
import { createParkRoutes } from "@/http/parkRoutes";
import { createWindowRoutes } from "@/http/windowRoutes";
import { createWebrtcTileRoutes } from "@/http/tile-peer/webrtcTileRoutes";
import type { RouteHandler } from "@/http/route";
import { createSessionRoutes } from "@/http/session-routes/sessionRoutes";
import { createSummaryRoutes } from "@/http/session-routes/summaryRoutes";
import { createTaskRoutes } from "@/http/session-routes/taskRoutes";
import { createAgentTerminalRoutes } from "@/http/agentTerminalRoutes";
import { createTmuxRoutes } from "@/http/tmuxRoutes";
import { createTimelineRoutes } from "@/http/session-routes/timelineRoutes";
import { createUsageRoutes } from "@/http/usageRoutes";
import { detectUsageVendors } from "@/usage/usageReport";
import { state } from "@/transcripts/transcriptState";
import {
  getSnapshot,
  getWatcherState,
  findSession,
  summarizeSession,
  subscribeCatalog,
  startCatalog,
  stopCatalog,
  registerPiSession,
  resolvePiSession,
  notifyPiSessionChanged,
} from "@/transcripts/catalog/transcriptCatalog";
import { AgentBackendRegistry } from "@/agents/agentBackend";
import { PiAgentBackend } from "@/agents/piAgentBackend";
import { ClaudeLiveBackend } from "@/live/claudeLiveBackend";
import { CodexLiveBackend } from "@/live/codexLiveBackend";
import { BotStore } from "@/bots/botStore";
import { BotRegistry } from "@/bots/botRegistry";
import { createAddBotTool } from "@/bots/addBotTool";
import { AgentTerminalService } from "@/terminal/agentTerminalService";

// Pi normally lazy-loads OAuth providers from sibling files. A standalone Bun
// executable has no such files beside it, so use Pi's static loader registry to
// make every supported OAuth implementation part of the compiled sidecar.
registerBunOAuthFlows();

const backends = new AgentBackendRegistry();
const resolveBackend = (id: string) => backends.get(id);
const describeAgentSession = (source: string, sessionId: string) =>
  backends.get(source)?.describeSession(sessionId);
const botStore = new BotStore(config.botsPath);
const botRegistry = new BotRegistry(botStore, {
  resolveProject(path) {
    return getSnapshot().some((session) => session.project === path)
      ? { projectPath: path }
      : undefined;
  },
  resolveSession(ref) {
    const session = findSession(ref.source, ref.sessionId);
    return session
      ? { projectPath: session.project, summary: summarizeSession(session, describeAgentSession) }
      : undefined;
  },
  subscribe(listener) {
    return subscribeCatalog(() => listener());
  },
});
const agentTerminals = new AgentTerminalService(
  config.ptyManagerSocketPath,
  (source, sessionId) => {
    const session = findSession(source, sessionId);
    if (!session) return undefined;
    const summary = summarizeSession(session, describeAgentSession);
    return {
      projectPath: session.project,
      activity: summary.activity,
    };
  },
);
backends.register(new PiAgentBackend({
  resolveSession: resolvePiSession,
  onSessionCreated: registerPiSession,
  onSessionChanged: notifyPiSessionChanged,
  customToolsForSession: async ({ source, sessionId }) =>
    await botRegistry.botAllowedToAdd({ source, sessionId })
      ? [createAddBotTool(botRegistry, { source, sessionId })]
      : [],
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
const routes: RouteHandler[] = [
  createInventoryRoutes(describeAgentSession),
  createBotRoutes(botRegistry),
  createAgentTerminalRoutes(agentTerminals),
  createTmuxRoutes(),
  createAgentRoutes(resolveBackend),
  // Ahead of the session routes so `/timeline` is matched before their
  // catch-all rejection of unknown `/api/sessions/` paths.
  createTimelineRoutes(resolveBackend, describeAgentSession),
  // Ahead of them for the same reason: `/tasks` and `/tasks/<id>/output` live under
  // `/api/sessions/` and would otherwise be rejected before they are matched.
  createTaskRoutes(),
  // And again: `/input` is under `/api/sessions/` too.
  createCliInputRoutes(),
  // And `/composer`, which is the other way of typing at the same session. It takes the pane
  // signal from the terminal service because that service owns the pane's one pipe.
  createTmuxComposerRoutes(liveTmuxComposerDependencies(
    (pane, onOutput) => agentTerminals.watchPane(pane, onOutput),
  )),
  // Same reason again: `/summary` lives under `/api/sessions/`.
  createSummaryRoutes(resolveBackend, describeAgentSession),
  // Not under `/api/sessions/` at all -- usage is a fact about the machine -- so its position
  // here is only for readability.
  createUsageRoutes(),
  createParkRoutes(),
  // Desktop and window reads through the standalone helper. Not under `/api/sessions/`, so its
  // position here is only for readability.
  createWindowRoutes(),
  createWebrtcTileRoutes(),
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
    // The control API is unauthenticated on purpose: the sidecar binds to loopback, the tailnet
    // reaches only the panel in front of it, and the tailnet is the trust boundary. There is no
    // token to mint, plumb, or type in to add a session.
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
// Announce on the shared board so any panel on the machine can offer this session with no port
// hand-fed to it. Withdrawn in shutdown; a crash leaves a descriptor that ages out on its own.
const announcement = announceSidecar(config.port);
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
  announcement.stop();
  await stopCatalog();
  agentTerminals.stop();
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
