import { config } from "./config.ts";
import {
  BYE_BYTES,
  CORS_HEADERS,
  jsonResponse,
} from "./http/httpResponses.ts";
import { handleProjectRoutes } from "./http/projectRoutes.ts";
import type { RouteHandler } from "./http/route.ts";
import { handleSessionRoutes } from "./http/sessionRoutes.ts";
import { state } from "./transcripts/transcriptState.ts";
import {
  getSnapshot,
  getWatcherState,
  startCatalog,
  stopCatalog,
} from "./transcripts/transcriptCatalog.ts";

const routes: RouteHandler[] = [handleProjectRoutes, handleSessionRoutes];
const SHUTDOWN_GRACE_MS = 500;

const server = Bun.serve<undefined>({
  hostname: config.host,
  port: config.port,
  fetch(request, bunServer) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
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
      headers: CORS_HEADERS,
    });
  },
});

console.log(`agent feed sidecar listening on http://${config.host}:${server.port}`);
void startCatalog().catch((error) => {
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
  server.stop(true);
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
