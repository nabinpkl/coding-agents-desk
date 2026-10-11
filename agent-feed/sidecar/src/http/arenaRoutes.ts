// `/api/arena/*` -- one prompt fanned out to contestants, and the facts each left behind.
//
// Five answers: POST makes a run, GET lists them, GET on a run id answers its facts, DELETE
// tears a finished one down, and `stream` pushes the whole status list whenever any run moves.
// The service owns every state change; this module only matches paths, checks shapes and maps
// the service's errors onto the statuses the panel's own client reads.

import type { ArenaRunsStreamMessage } from "@agentdesk/agent-feed-wire";
import {
  ArenaBadRequestError,
  ArenaRunBusyError,
  ArenaRunNotFoundError,
  ArenaService,
} from "@/arena/arenaService";
import { encodeServerSentEvent, errorResponse, jsonResponse, startServerSentEventStream } from "@/http/protocol/httpResponses";
import type { RouteHandler } from "@/http/protocol/route";

const RUNS_ROUTE = "/api/arena/runs";
const RUNS_STREAM_ROUTE = "/api/arena/runs/stream";
const RUN_ROUTE = /^\/api\/arena\/runs\/([0-9a-f-]{36})$/;

export function createArenaRoutes(service: ArenaService): RouteHandler {
  return (request, url, server) => {
    if (!url.pathname.startsWith(`${RUNS_ROUTE}/`) && url.pathname !== RUNS_ROUTE) return undefined;

    if (url.pathname === RUNS_ROUTE) {
      if (request.method === "GET") return jsonResponse({ runs: service.listRuns() });
      if (request.method === "POST") return createRun(service, request);
      return methodNotAllowed(request.method);
    }

    if (url.pathname === RUNS_STREAM_ROUTE) {
      if (request.method !== "GET") return methodNotAllowed(request.method);
      const message = (): ArenaRunsStreamMessage => ({ type: "runs", runs: service.listRuns() });
      return startServerSentEventStream(request, server, (write) => {
        write(encodeServerSentEvent(message()));
        return service.onRunsChanged(() => write(encodeServerSentEvent(message())));
      });
    }

    const runId = RUN_ROUTE.exec(url.pathname)?.[1];
    if (!runId) return notFound(url.pathname);

    if (request.method === "GET") {
      const detail = service.runDetailFor(runId);
      if (!detail) return notFound(url.pathname);
      return jsonResponse(detail);
    }
    if (request.method === "DELETE") return deleteRun(service, runId, url.pathname);
    return methodNotAllowed(request.method);
  };
}

async function createRun(service: ArenaService, request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("arena-bad-request", "a run request must be JSON", 400);
  }
  try {
    const run = await service.createRun((body ?? {}) as Parameters<ArenaService["createRun"]>[0]);
    return jsonResponse(run, 201);
  } catch (error) {
    if (error instanceof ArenaBadRequestError) {
      return errorResponse("arena-bad-request", error.message, 400);
    }
    return internal(error);
  }
}

async function deleteRun(service: ArenaService, runId: string, path: string): Promise<Response> {
  try {
    await service.deleteRun(runId);
    return jsonResponse({ deleted: runId });
  } catch (error) {
    if (error instanceof ArenaRunNotFoundError) return notFound(path);
    if (error instanceof ArenaRunBusyError) {
      return errorResponse("arena-run-busy", error.message, 409);
    }
    return internal(error);
  }
}

function methodNotAllowed(method: string): Response {
  return errorResponse("arena-method", `"${method}" is not an arena route's method`, 405);
}

function notFound(path: string): Response {
  return errorResponse("arena-run-not-found", `no arena run at "${path}"`, 404);
}

function internal(error: unknown): Response {
  console.error("agent feed arena route failed", error);
  return errorResponse(
    "arena-internal",
    error instanceof Error ? error.message : String(error),
    500,
  );
}
