// How a Bot route reads its request and spells its failures, shared by every Bot route.
//
// Apart from the routes themselves so the table in `botRoutes.ts` reads as a table: which path
// does what, with the body parsing and the error mapping each handler shares stated once.

import {
  BotConflictError,
  BotForbiddenError,
  BotInvalidError,
  BotLaunchError,
  BotNotFoundError,
} from "@/bots/botRegistry";
import { errorResponse } from "@/http/protocol/httpResponses";

const MAXIMUM_BODY_BYTES = 256 * 1024;

export function decodeBotId(botId: string): string {
  try {
    return decodeURIComponent(botId);
  } catch (error) {
    throw new BotInvalidError("botId is not valid URL encoding", { cause: error });
  }
}

export async function requestObject(request: Request): Promise<Record<string, unknown> | Response> {
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

export function routeError(error: unknown): Response {
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

export function errorPayload(error: unknown) {
  return {
    code: "bot-stream-failed",
    message: error instanceof Error ? error.message : String(error),
    retryable: true,
  };
}
