import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { config } from "./config.ts";
import {
  BYE_BYTES,
  jsonResponse,
} from "./http/httpResponses.ts";
import { authorizeApiRequest } from "./http/auth.ts";
import { createAgentRoutes } from "./http/agentRoutes.ts";
import { handleProjectRoutes } from "./http/projectRoutes.ts";
import type { RouteHandler } from "./http/route.ts";
import { createSessionRoutes } from "./http/sessionRoutes.ts";
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
const routes: RouteHandler[] = [
  handleProjectRoutes,
  createAgentRoutes((id) => backends.get(id)),
  createSessionRoutes((source, sessionId) =>
    backends.get(source)?.describeSession(sessionId)
  ),
];
const SHUTDOWN_GRACE_MS = 500;

const server = Bun.serve<undefined>({
  hostname: config.host,
  port: config.port,
  fetch(request, bunServer) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      const denied = authorizeApiRequest(request, config.controlToken);
      if (denied) return denied;
    }
    if (request.method === "GET" && url.pathname === "/api/config") {
      return jsonResponse({
        staleThresholdMs: config.staleThresholdMs,
        readyThresholdMs: config.readyThresholdMs,
        liveWindowMs: config.liveWindowMs,
        watcherState: getWatcherState(),
        sessionCount: getSnapshot().length,
      });
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
