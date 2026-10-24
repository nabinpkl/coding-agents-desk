// `POST /api/sessions/:source/:sessionId/log` -- a session stating which agent log it keeps
// (ADR-0147).
//
// Addressed by the session, as the bracket route is, because the caller is an agent that knows its
// own session id and not its Bot: the registry finds the one Bot holding it. The body is
// `{ "path": ".agents/agents-log/<name>.log" }`, relative to where the session works. Called by
// `tools/agent-log-register.sh` after every line an agent appends, so a repeat answers `already`
// and writes nothing.

import { normalizeSessionRef } from "@/bots/botCommands";
import { BotConflictError, BotInvalidError, BotNotFoundError, type BotRegistry } from "@/bots/botRegistry";
import { normalizeLogPath } from "@/bots/sessions/botSessionLogs";
import { errorResponse, jsonResponse } from "@/http/protocol/httpResponses";
import type { RouteHandler } from "@/http/protocol/route";

const LOG_ROUTE = /^\/api\/sessions\/([^/]+)\/([^/]+)\/log$/;

export function createAgentLogRoutes(registry: Pick<BotRegistry, "registerSessionLog">): RouteHandler {
  return (request, url) => {
    if (request.method !== "POST") return undefined;
    const match = LOG_ROUTE.exec(url.pathname);
    if (!match) return undefined;
    return registerLog(request, match[1]!, match[2]!, registry);
  };
}

async function registerLog(
  request: Request,
  source: string,
  sessionId: string,
  registry: Pick<BotRegistry, "registerSessionLog">,
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("invalid-request", "request body must be JSON", 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return errorResponse("invalid-request", "request body must be an object", 400);
  }
  try {
    const ref = normalizeSessionRef({ source: decodeSegment(source), sessionId: decodeSegment(sessionId) });
    const path = normalizeLogPath((body as Record<string, unknown>).path);
    return jsonResponse(await registry.registerSessionLog(ref, path));
  } catch (error) {
    return routeError(error);
  }
}

function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new BotInvalidError("the session is not valid URL encoding");
  }
}

/** The Bot codes the bracket route answers, so a caller reads one vocabulary from both. */
function routeError(error: unknown): Response {
  if (error instanceof BotInvalidError) return errorResponse("invalid-bot", error.message, 400);
  if (error instanceof BotNotFoundError) return errorResponse("bot-resource-not-found", error.message, 404);
  if (error instanceof BotConflictError) return errorResponse("bot-conflict", error.message, 409);
  console.error("Session log registration failed", error);
  return errorResponse("log-registration-failed", error instanceof Error ? error.message : String(error), 500);
}
