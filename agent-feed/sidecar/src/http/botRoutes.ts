import type {
  AddBotCommand,
  AddBotSessionsCommand,
  BotGitDiff,
  BotGitStatus,
  DetachBotSessionsCommand,
  ReorderBotSessionsCommand,
  RetireBotSessionsCommand,
  SetBotCanvasCommand,
} from "@agentdesk/agent-feed-wire";
import {
  BotConflictError,
  BotForbiddenError,
  BotInvalidError,
  BotLaunchError,
  BotNotFoundError,
  type BotRegistry,
} from "@/bots/botRegistry";
import {
  encodeServerSentEvent,
  errorResponse,
  jsonResponse,
  startServerSentEventStream,
} from "@/http/httpResponses";
import type { RouteHandler } from "@/http/route";
import { readGitStatus, workingTreeFileDiff } from "@/workspace/workspaceGit";
import { WorkspaceFailure } from "@/workspace/workspacePaths";

const BOTS_ROUTE = "/api/bots";
const BOTS_STREAM_ROUTE = "/api/bots/stream";
const MAXIMUM_BODY_BYTES = 256 * 1024;

export function createBotRoutes(registry: BotRegistry): RouteHandler {
  return (request, url, server) => {
    if (request.method === "GET" && url.pathname === BOTS_ROUTE) {
      return registry.snapshot().then((snapshot) => jsonResponse(snapshot), routeError);
    }
    if (request.method === "GET" && url.pathname === BOTS_STREAM_ROUTE) {
      return startServerSentEventStream(request, server, (write) => {
        let closed = false;
        let unsubscribe: (() => void) | undefined;
        void registry.subscribe(
          (snapshot) => write(encodeServerSentEvent(snapshot)),
          (error) => write(encodeServerSentEvent({ error: errorPayload(error) })),
        )
          .then((stop) => {
            if (closed) stop();
            else unsubscribe = stop;
          })
          .catch((error) => write(encodeServerSentEvent({ error: errorPayload(error) })));
        return () => {
          closed = true;
          unsubscribe?.();
        };
      });
    }
    if (request.method === "POST" && url.pathname === BOTS_ROUTE) {
      return createBot(request, registry);
    }
    const sessionsMatch = /^\/api\/bots\/([^/]+)\/sessions$/.exec(url.pathname);
    if (request.method === "POST" && sessionsMatch) {
      return addBotSessions(request, sessionsMatch[1]!, registry);
    }
    // Removal is a POST to its own path rather than a DELETE on the one above, because the panel's
    // only route to this sidecar inside the WKWebView is the host relay, and that relay admits GET
    // and POST alone (`AgentFeedRelay.PathPolicy`). The allow-list is the boundary that keeps the
    // relay from being an open local proxy, so it is worth spelling a verb around rather than
    // widening.
    const detachMatch = /^\/api\/bots\/([^/]+)\/sessions\/detach$/.exec(url.pathname);
    if (request.method === "POST" && detachMatch) {
      return detachBotSessions(request, detachMatch[1]!, registry);
    }
    // Retiring is detaching plus everything the launch created, so it sits beside it and for the
    // same reason: a POST rather than a DELETE, because the relay above admits two verbs.
    const retireMatch = /^\/api\/bots\/([^/]+)\/sessions\/retire$/.exec(url.pathname);
    if (request.method === "POST" && retireMatch) {
      return retireBotSessions(request, retireMatch[1]!, registry);
    }
    // Reordering is neither of those: the same references, standing differently. Its own path for
    // the same reason they have theirs -- `/sessions` is where a body naming sessionRefs ATTACHES
    // them, so a reorder posted there would add every session the Bot already has.
    const orderMatch = /^\/api\/bots\/([^/]+)\/sessions\/order$/.exec(url.pathname);
    if (request.method === "POST" && orderMatch) {
      return reorderBotSessions(request, orderMatch[1]!, registry);
    }
    const canvasMatch = /^\/api\/bots\/([^/]+)\/canvas$/.exec(url.pathname);
    if (request.method === "POST" && canvasMatch) {
      return setBotCanvas(request, canvasMatch[1]!, registry);
    }
    // What is uncommitted in the Bot's directory, and one path of it. Reads, so GETs, and the
    // Bot's own paths rather than the IDE's: see `BotGitStatus` for why a Bot is not a workspace.
    const gitMatch = /^\/api\/bots\/([^/]+)\/git$/.exec(url.pathname);
    if (request.method === "GET" && gitMatch) {
      return botGitStatus(gitMatch[1]!, registry);
    }
    const gitDiffMatch = /^\/api\/bots\/([^/]+)\/git\/diff$/.exec(url.pathname);
    if (request.method === "GET" && gitDiffMatch) {
      return botGitDiff(gitDiffMatch[1]!, url.searchParams.get("path"), registry);
    }
    return undefined;
  };
}

/**
 * The directory a Bot is bound to, from the roster rather than from the request.
 *
 * Only a Bot's own directory can be read this way, which is the confinement: the panel names a Bot,
 * never a path on the disk.
 */
async function botDirectory(botId: string, registry: BotRegistry): Promise<string> {
  const decodedBotId = decodeBotId(botId);
  const bot = (await registry.snapshot()).bots.find((each) => each.botId === decodedBotId);
  if (!bot) throw new BotNotFoundError(`no Bot "${decodedBotId}"`);
  if (bot.environmentAvailability === "missing") {
    throw new BotConflictError(`the directory of "${bot.name}" is missing`);
  }
  return bot.environment.path;
}

async function botGitStatus(botId: string, registry: BotRegistry): Promise<Response> {
  try {
    const status = await readGitStatus(await botDirectory(botId, registry));
    const answer: BotGitStatus = {
      botId: decodeBotId(botId),
      repository: status !== null,
      branch: status?.branch ?? null,
      entries: status?.entries ?? [],
    };
    return jsonResponse(answer);
  } catch (error) {
    return routeError(error);
  }
}

async function botGitDiff(
  botId: string,
  path: string | null,
  registry: BotRegistry,
): Promise<Response> {
  try {
    if (!path) throw new BotInvalidError("path is required");
    const directory = await botDirectory(botId, registry);
    const diff = await workingTreeFileDiff(directory, path);
    const answer: BotGitDiff = { botId: decodeBotId(botId), path, ...diff };
    return jsonResponse(answer);
  } catch (error) {
    // The workspace's refusals, spelled the way this route spells its own: a path that is not a
    // change is a missing resource, and one that is not a relative path is a bad request.
    if (error instanceof WorkspaceFailure) {
      return error.code === "notFound"
        ? errorResponse("bot-git-path-not-found", `"${path}" has no uncommitted change`, 404)
        : errorResponse("invalid-bot", error.message, 400);
    }
    return routeError(error);
  }
}

async function createBot(request: Request, registry: BotRegistry): Promise<Response> {
  try {
    const body = await requestObject(request);
    if (body instanceof Response) return body;
    return jsonResponse(await registry.add(body as unknown as AddBotCommand, { kind: "user" }), 201);
  } catch (error) {
    return routeError(error);
  }
}

async function addBotSessions(
  request: Request,
  botId: string,
  registry: BotRegistry,
): Promise<Response> {
  try {
    const decodedBotId = decodeBotId(botId);
    const body = await requestObject(request);
    if (body instanceof Response) return body;
    return jsonResponse(
      await registry.addSessions(decodedBotId, body as unknown as AddBotSessionsCommand, { kind: "user" }),
    );
  } catch (error) {
    return routeError(error);
  }
}

async function detachBotSessions(
  request: Request,
  botId: string,
  registry: BotRegistry,
): Promise<Response> {
  try {
    const decodedBotId = decodeBotId(botId);
    const body = await requestObject(request);
    if (body instanceof Response) return body;
    return jsonResponse(
      await registry.detachSessions(decodedBotId, body as unknown as DetachBotSessionsCommand, { kind: "user" }),
    );
  } catch (error) {
    return routeError(error);
  }
}

async function retireBotSessions(
  request: Request,
  botId: string,
  registry: BotRegistry,
): Promise<Response> {
  try {
    const decodedBotId = decodeBotId(botId);
    const body = await requestObject(request);
    if (body instanceof Response) return body;
    return jsonResponse(
      await registry.retireSessions(decodedBotId, body as unknown as RetireBotSessionsCommand, { kind: "user" }),
    );
  } catch (error) {
    return routeError(error);
  }
}

async function reorderBotSessions(
  request: Request,
  botId: string,
  registry: BotRegistry,
): Promise<Response> {
  try {
    const decodedBotId = decodeBotId(botId);
    const body = await requestObject(request);
    if (body instanceof Response) return body;
    return jsonResponse(
      await registry.reorderSessions(decodedBotId, body as unknown as ReorderBotSessionsCommand, { kind: "user" }),
    );
  } catch (error) {
    return routeError(error);
  }
}

async function setBotCanvas(
  request: Request,
  botId: string,
  registry: BotRegistry,
): Promise<Response> {
  try {
    const decodedBotId = decodeBotId(botId);
    const body = await requestObject(request);
    if (body instanceof Response) return body;
    return jsonResponse(
      await registry.setCanvas(decodedBotId, body as unknown as SetBotCanvasCommand, { kind: "user" }),
    );
  } catch (error) {
    return routeError(error);
  }
}

function decodeBotId(botId: string): string {
  try {
    return decodeURIComponent(botId);
  } catch (error) {
    throw new BotInvalidError("botId is not valid URL encoding", { cause: error });
  }
}

async function requestObject(request: Request): Promise<Record<string, unknown> | Response> {
  const announced = Number(request.headers.get("content-length") ?? 0);
  if (announced > MAXIMUM_BODY_BYTES) {
    return errorResponse("body-too-large", "request body exceeds 256 KiB", 413);
  }
  const bytes = await request.bytes();
  if (bytes.byteLength > MAXIMUM_BODY_BYTES) {
    return errorResponse("body-too-large", "request body exceeds 256 KiB", 413);
  }
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return errorResponse("invalid-json", "request body is not valid JSON", 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return errorResponse("invalid-request", "request body must be an object", 400);
  }
  return body as Record<string, unknown>;
}

function routeError(error: unknown): Response {
  if (error instanceof BotInvalidError) return errorResponse("invalid-bot", error.message, 400);
  if (error instanceof BotNotFoundError) return errorResponse("bot-resource-not-found", error.message, 404);
  if (error instanceof BotConflictError) return errorResponse("bot-conflict", error.message, 409);
  if (error instanceof BotForbiddenError) return errorResponse("bot-forbidden", error.message, 403);
  // 502 rather than 500: the request was valid and the Bot was written. What failed is the thing
  // this sidecar delegates to -- tmux, or the CLI it starts -- and the message says the Bot
  // survived, so a caller retrying the identical command would collide with its own Bot.
  if (error instanceof BotLaunchError) {
    return errorResponse("bot-launch-failed", error.message, 502);
  }
  console.error("Bot route failed", error);
  return errorResponse("bot-store-failed", error instanceof Error ? error.message : String(error), 500);
}

function errorPayload(error: unknown) {
  return {
    code: "bot-stream-failed",
    message: error instanceof Error ? error.message : String(error),
    retryable: true,
  };
}
