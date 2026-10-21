// The panel asking to hear something on this Mac's speech process.
//
//   POST /api/speech/read  <- { text }  -> { listeners, durationMs }, or 409 nobody_listening / stopped
//   POST /api/speech/stop  -> 204 once the reply being read is stopped
//
// The feed's speaker on a reply: the reply's text is read out loud through the same queue as the
// sessions' own announcements (`sessionSpeech.ts`), so the two never talk over each other.

import { SPEECH_READ_ROUTE, SPEECH_STOP_ROUTE, type SpeechReadResponse } from "@agentdesk/agent-feed-wire";
import { errorResponse, jsonResponse } from "@/http/protocol/httpResponses";
import type { RouteHandler } from "@/http/protocol/route";
import { readAloud, stopReading, type SpeechOutcome } from "@/push/sessionSpeech";

/** A reply this long is a paste, not something to read out; the reader cuts long ones anyway. */
const MAX_BODY_CHARS = 200_000;

async function read(request: Request, speak: typeof readAloud): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("invalid_request", "body is not JSON", 400);
  }
  const text = (body as { text?: unknown } | null)?.text;
  if (typeof text !== "string" || !text.trim() || text.length > MAX_BODY_CHARS) {
    return errorResponse(
      "invalid_request",
      `expected { text } with something to read, under ${MAX_BODY_CHARS} characters`,
      400,
    );
  }
  const outcome: SpeechOutcome | null = await speak(text);
  if (!outcome) return errorResponse("nothing_to_say", "nothing in that text can be read out loud", 422);
  if (outcome.said)
    return jsonResponse({ listeners: outcome.listeners, durationMs: outcome.durationMs } satisfies SpeechReadResponse);
  if (outcome.why === "nobody-listening") {
    return errorResponse("nobody_listening", "nothing is listening on the speech process's stream", 409);
  }
  if (outcome.why === "replaced" || outcome.why === "stopped") {
    return errorResponse("stopped", "the reading was stopped, or another replaced it", 409);
  }
  return errorResponse("speech_failed", "the speech process could not say it", 502);
}

async function stop(halt: typeof stopReading): Promise<Response> {
  try {
    await halt();
  } catch (error) {
    return errorResponse("speech_unreachable", `the speech process did not take the stop: ${String(error)}`, 502);
  }
  return new Response(null, { status: 204 });
}

export function createSpeechRoutes(
  speak: typeof readAloud = readAloud,
  halt: typeof stopReading = stopReading,
): RouteHandler {
  return (request, url) => {
    if (url.pathname === SPEECH_READ_ROUTE && request.method === "POST") return read(request, speak);
    if (url.pathname === SPEECH_STOP_ROUTE && request.method === "POST") return stop(halt);
    return undefined;
  };
}
