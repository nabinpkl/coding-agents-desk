import type { AddBotCommand, AttachBotSessionsCommand } from "@agentdesk/agent-feed-wire";
import {
  BotConflictError,
  BotForbiddenError,
  BotInvalidError,
  BotNotFoundError,
  type BotRegistry,
} from "../bots/botRegistry.ts";
import { encodeServerSentEvent, jsonResponse, startServerSentEventStream } from "./httpResponses.ts";
import type { RouteHandler } from "./route.ts";

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
      return attachBotSessions(request, sessionsMatch[1]!, registry);
    }
    return undefined;
  };
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

async function attachBotSessions(
  request: Request,
  botId: string,
  registry: BotRegistry,
): Promise<Response> {
  try {
    let decodedBotId: string;
    try {
      decodedBotId = decodeURIComponent(botId);
    } catch (error) {
      throw new BotInvalidError("botId is not valid URL encoding", { cause: error });
    }
    const body = await requestObject(request);
    if (body instanceof Response) return body;
    return jsonResponse(
      await registry.attachSessions(decodedBotId, body as unknown as AttachBotSessionsCommand, { kind: "user" }),
    );
  } catch (error) {
    return routeError(error);
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

function errorResponse(code: string, message: string, status: number): Response {
  return jsonResponse({ error: { code, message, retryable: status >= 500 } }, status);
}
