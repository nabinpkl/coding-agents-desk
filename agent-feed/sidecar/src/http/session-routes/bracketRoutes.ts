// `POST /api/sessions/:source/:sessionId/bracket` -- naming what one session is doing now.
//
// The completion path every `set_task` door forwards to, addressed by the session rather than
// the Bot: renaming a bracket is something done to a session, and it moved off the Bot endpoint
// for the same reason forking did (see `forkSession` in `sessionRoutes.ts`). The response still
// names the holding Bot, because the anchor the task brackets onto is the Bot's own, resolved
// through the registry -- the route moved, the authority did not.
//
// A POST, because it runs the session's own rename rather than writing a field: the same act
// family retiring belongs to, and an empty task starts the session bare under its anchor rather
// than clearing anything.

import { normalizeBracketCommand } from "@/bots/botCommands";
import {
  BotConflictError,
  BotForbiddenError,
  BotInvalidError,
  BotNotFoundError,
  type BotRegistry,
} from "@/bots/botRegistry";
import type { BotSessionRenamer } from "@/bots/sessions/botTitleNormalize";
import { errorResponse, jsonResponse } from "@/http/httpResponses";
import type { RouteHandler } from "@/http/route";

const BRACKET_ROUTE = /^\/api\/sessions\/([^/]+)\/([^/]+)\/bracket$/;

export function createBracketRoutes(
  registry: BotRegistry,
  dependencies: { renameSession: BotSessionRenamer },
): RouteHandler {
  return (request, url) => {
    if (request.method !== "POST") return undefined;
    const match = BRACKET_ROUTE.exec(url.pathname);
    if (!match) return undefined;
    return renameBracket(request, match[1]!, match[2]!, registry, dependencies.renameSession);
  };
}

async function renameBracket(
  request: Request,
  source: string,
  sessionId: string,
  registry: BotRegistry,
  renameSession: BotSessionRenamer,
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
    // The session travels in the path and the task in the body; the normalizer validates both
    // halves together, so an unknown source is refused the same way a missing task is.
    const { ref, task } = normalizeBracketCommand({
      ...(body as Record<string, unknown>),
      source: decodePathSegment(source, "source"),
      sessionId: decodePathSegment(sessionId, "sessionId"),
    });
    return jsonResponse(await registry.renameBracket(ref, task, renameSession));
  } catch (error) {
    return routeError(error);
  }
}

function decodePathSegment(value: string, name: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new BotInvalidError(`${name} is not valid URL encoding`);
  }
}

/**
 * The Bot error contract, repeated from `botRoutes.ts` rather than shared with it.
 *
 * The codes are what callers render, so both addresses must answer the same ones while both
 * exist -- and after the old address is gone, this is the only copy. One mapping in one file
 * beats an export both route tables reach for, because neither table owns the other's errors.
 */
function routeError(error: unknown): Response {
  if (error instanceof BotInvalidError) {
    return errorResponse("invalid-bot", error.message, 400);
  }
  if (error instanceof BotNotFoundError) {
    return errorResponse("bot-resource-not-found", error.message, 404);
  }
  if (error instanceof BotConflictError) {
    return errorResponse("bot-conflict", error.message, 409);
  }
  if (error instanceof BotForbiddenError) {
    return errorResponse("bot-forbidden", error.message, 403);
  }
  // 502 rather than 500: the request was valid and the Bot was written. What failed is the thing
  // this sidecar delegates to -- the session's own rename.
  console.error("Session bracket rename failed", error);
  return errorResponse(
    "bracket-failed",
    error instanceof Error ? error.message : String(error),
    502,
  );
}
