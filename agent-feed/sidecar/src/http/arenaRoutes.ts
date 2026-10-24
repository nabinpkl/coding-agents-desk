// `/api/arena/*` -- one prompt fanned out to contestants, and the facts each left behind.
//
// Nine answers: POST makes a run, GET lists them, GET on a run id answers its facts, DELETE
// tears a settled one down, `stream` pushes the whole status list whenever any run moves,
// `new-run` says what a run asked for with nothing filled in would get here (the modes this
// machine has, the arena home, the next free name), and POST on a run's `prompt` gives it its
// next prompt: the first, to a terminals run whose lanes wait for it, or the next, to every
// contestant once the last prompt has settled; POST on a run's `contestants` adds lanes to a
// terminals run before its first prompt, which is how a run's manager starts the lanes it planned;
// and POST on a run's `pass` sends one lane's latest answer to a lane of the other stance; POST on
// `folders` says what a run would make of each folder named, for the new-run form, and POST on
// `folders/repository` makes a plain folder a repository, which only the reader asks for.
// The service owns every state change; this module only matches paths, checks shapes and maps
// the service's errors onto the statuses the panel's own client reads.

import type {
  ArenaFoldersRequest,
  ArenaFoldersResponse,
  ArenaMakeRepositoryRequest,
  ArenaRunsStreamMessage,
} from "@agentdesk/agent-feed-wire";
import { ArenaFolderRefusedError, makeFolderRepository } from "@/arena/arenaWorktrees";
import { ArenaBadRequestError, ArenaRunBusyError, ArenaRunNotFoundError, ArenaService } from "@/arena/arenaService";
import {
  encodeServerSentEvent,
  errorResponse,
  jsonResponse,
  startServerSentEventStream,
} from "@/http/protocol/httpResponses";
import type { RouteHandler } from "@/http/protocol/route";

const RUNS_ROUTE = "/api/arena/runs";
const RUNS_STREAM_ROUTE = "/api/arena/runs/stream";
const NEW_RUN_ROUTE = "/api/arena/new-run";
const FOLDERS_ROUTE = "/api/arena/folders";
const FOLDER_REPOSITORY_ROUTE = "/api/arena/folders/repository";
/** Enough for every project a catalog lists, and a bound on the stats one request makes. */
const MAXIMUM_FOLDERS = 500;
const RUN_ROUTE = /^\/api\/arena\/runs\/([0-9a-f-]{36})$/;
const RUN_PROMPT_ROUTE = /^\/api\/arena\/runs\/([0-9a-f-]{36})\/prompt$/;
const RUN_LANES_ROUTE = /^\/api\/arena\/runs\/([0-9a-f-]{36})\/contestants$/;
const RUN_PASS_ROUTE = /^\/api\/arena\/runs\/([0-9a-f-]{36})\/pass$/;

export function createArenaRoutes(service: ArenaService): RouteHandler {
  return (request, url, server) => {
    if (url.pathname === NEW_RUN_ROUTE) {
      if (request.method !== "GET") return methodNotAllowed(request.method);
      return jsonResponse(service.newRunDefaults());
    }
    if (url.pathname === FOLDERS_ROUTE) {
      if (request.method !== "POST") return methodNotAllowed(request.method);
      return inspectFolders(service, request);
    }
    if (url.pathname === FOLDER_REPOSITORY_ROUTE) {
      if (request.method !== "POST") return methodNotAllowed(request.method);
      return makeRepository(service, request);
    }
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

    const promptRunId = RUN_PROMPT_ROUTE.exec(url.pathname)?.[1];
    if (promptRunId) {
      if (request.method !== "POST") return methodNotAllowed(request.method);
      return sendPrompt(service, promptRunId, request, url.pathname);
    }

    const passRunId = RUN_PASS_ROUTE.exec(url.pathname)?.[1];
    if (passRunId) {
      if (request.method !== "POST") return methodNotAllowed(request.method);
      return passAnswer(service, passRunId, request, url.pathname);
    }

    const lanesRunId = RUN_LANES_ROUTE.exec(url.pathname)?.[1];
    if (lanesRunId) {
      if (request.method !== "POST") return methodNotAllowed(request.method);
      return addContestants(service, lanesRunId, request, url.pathname);
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

async function inspectFolders(service: ArenaService, request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("arena-bad-request", "a folders request must be JSON", 400);
  }
  const paths = (body as Partial<ArenaFoldersRequest> | null)?.paths;
  if (!Array.isArray(paths) || !paths.every((path) => typeof path === "string")) {
    return errorResponse("arena-bad-request", "a folders request names its paths as strings", 400);
  }
  if (paths.length > MAXIMUM_FOLDERS) {
    return errorResponse("arena-bad-request", `at most ${MAXIMUM_FOLDERS} folders a request`, 400);
  }
  const folders = await Promise.all(paths.map((path) => service.worktrees.inspectFolder(path)));
  return jsonResponse({ folders } satisfies ArenaFoldersResponse);
}

async function makeRepository(service: ArenaService, request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("arena-bad-request", "a repository request must be JSON", 400);
  }
  const path = (body as Partial<ArenaMakeRepositoryRequest> | null)?.path;
  if (typeof path !== "string" || path.trim() === "") {
    return errorResponse("arena-bad-request", "a repository request names its folder's path", 400);
  }
  try {
    return jsonResponse(await makeFolderRepository(service.worktrees, path));
  } catch (error) {
    if (error instanceof ArenaFolderRefusedError) return errorResponse("arena-bad-request", error.message, 400);
    return internal(error);
  }
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

async function sendPrompt(service: ArenaService, runId: string, request: Request, path: string): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("arena-bad-request", "a prompt request must be JSON", 400);
  }
  try {
    return jsonResponse(service.sendPrompt(runId, (body as { prompt?: unknown } | null)?.prompt));
  } catch (error) {
    if (error instanceof ArenaRunNotFoundError) return notFound(path);
    if (error instanceof ArenaBadRequestError) return errorResponse("arena-bad-request", error.message, 400);
    // The lanes are still on the last prompt: a conflict with the run's state, not a bad request.
    if (error instanceof ArenaRunBusyError) return errorResponse("arena-run-busy", error.message, 409);
    return internal(error);
  }
}

async function passAnswer(service: ArenaService, runId: string, request: Request, path: string): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("arena-bad-request", "a pass request must be JSON", 400);
  }
  try {
    return jsonResponse(service.passAnswer(runId, body));
  } catch (error) {
    if (error instanceof ArenaRunNotFoundError) return notFound(path);
    if (error instanceof ArenaBadRequestError) return errorResponse("arena-bad-request", error.message, 400);
    // A lane is still on its last turn: a conflict with the run's state, not a bad request.
    if (error instanceof ArenaRunBusyError) return errorResponse("arena-run-busy", error.message, 409);
    return internal(error);
  }
}

async function addContestants(service: ArenaService, runId: string, request: Request, path: string): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("arena-bad-request", "a lanes request must be JSON", 400);
  }
  try {
    return jsonResponse(
      await service.addContestants(runId, (body as { contestants?: unknown } | null)?.contestants),
      201,
    );
  } catch (error) {
    if (error instanceof ArenaRunNotFoundError) return notFound(path);
    if (error instanceof ArenaBadRequestError) return errorResponse("arena-bad-request", error.message, 400);
    // The run has had its first prompt, or is adding lanes already: a conflict with its state.
    if (error instanceof ArenaRunBusyError) return errorResponse("arena-run-busy", error.message, 409);
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
  return errorResponse("arena-internal", error instanceof Error ? error.message : String(error), 500);
}
