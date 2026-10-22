// The panel asking to hear something on this Mac's speech process.
//
//   POST /api/speech/read       <- { text }  -> { listeners, durationMs }, or 409 nobody_listening / stopped
//   POST /api/speech/stop       -> 204 once the reply being read is stopped
//   POST /api/speech/here       <- { text, ref }  -> 200, the speech as float32 PCM, streamed as it is made
//   POST /api/speech/here/stop  <- { ref }  -> 204 once that speech is no longer being made
//
// The feed's two buttons on a reply. Broadcast (`read`) says it to Agent Radio's listeners, through
// the same queue as the sessions' own announcements (`sessionSpeech.ts`), so the two never talk over
// each other. The speaker (`here`) hands the speech back to the page that asked, to play on its own
// device, outside that queue. Both are this Mac's routes whichever machine the reply came from:
// only this Mac has the voice.

import {
  SPEECH_HERE_ROUTE,
  SPEECH_HERE_STOP_ROUTE,
  SPEECH_READ_ROUTE,
  SPEECH_SAMPLE_RATE,
  SPEECH_STOP_ROUTE,
  type SpeechReadResponse,
} from "@agentdesk/agent-feed-wire";
import { errorResponse, jsonResponse } from "@/http/protocol/httpResponses";
import type { RouteHandler } from "@/http/protocol/route";
import { readAloud, speechForPage, stopReading, stopSpeechForPage, type SpeechOutcome } from "@/push/sessionSpeech";

/** A reply this long is a paste, not something to read out; the reader cuts long ones anyway. */
const MAX_BODY_CHARS = 200_000;

/** A page's name for its playback. Prefixed before it reaches the speech process, so it cannot name a Bot's message. */
const PAGE_REF = /^[a-z0-9-]{1,64}$/i;

export type SpeechRouteDeps = {
  speak: typeof readAloud;
  halt: typeof stopReading;
  speakHere: typeof speechForPage;
  haltHere: typeof stopSpeechForPage;
};

const LIVE: SpeechRouteDeps = {
  speak: readAloud,
  halt: stopReading,
  speakHere: speechForPage,
  haltHere: stopSpeechForPage,
};

async function jsonBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json();
    return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  } catch {
    return null;
  }
}

function textOf(body: Record<string, unknown>): string | null {
  const text = body.text;
  return typeof text === "string" && text.trim() && text.length <= MAX_BODY_CHARS ? text : null;
}

const NO_TEXT = `expected { text } with something to read, under ${MAX_BODY_CHARS} characters`;

async function read(request: Request, speak: SpeechRouteDeps["speak"]): Promise<Response> {
  const body = await jsonBody(request);
  if (!body) return errorResponse("invalid_request", "body is not JSON", 400);
  const text = textOf(body);
  if (!text) return errorResponse("invalid_request", NO_TEXT, 400);
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

async function stop(halt: SpeechRouteDeps["halt"]): Promise<Response> {
  try {
    await halt();
  } catch (error) {
    return errorResponse("speech_unreachable", `the speech process did not take the stop: ${String(error)}`, 502);
  }
  return new Response(null, { status: 204 });
}

function pageRef(body: Record<string, unknown>): string | null {
  return typeof body.ref === "string" && PAGE_REF.test(body.ref) ? `page-${body.ref}` : null;
}

async function here(request: Request, speakHere: SpeechRouteDeps["speakHere"]): Promise<Response> {
  const body = await jsonBody(request);
  if (!body) return errorResponse("invalid_request", "body is not JSON", 400);
  const text = textOf(body);
  const ref = pageRef(body);
  if (!text || !ref)
    return errorResponse("invalid_request", `${NO_TEXT}, and a ref of letters, digits and dashes`, 400);
  let upstream: Response | null;
  try {
    upstream = await speakHere(text, ref);
  } catch (error) {
    return errorResponse("speech_unreachable", `the speech process did not answer: ${String(error)}`, 502);
  }
  if (!upstream) return errorResponse("nothing_to_say", "nothing in that text can be read out loud", 422);
  if (!upstream.ok || !upstream.body) {
    return errorResponse("speech_failed", `the speech process answered ${upstream.status}`, 502);
  }
  return new Response(upstream.body, {
    headers: {
      "content-type": "application/octet-stream",
      "cache-control": "no-store",
      "x-sample-rate": String(SPEECH_SAMPLE_RATE),
    },
  });
}

async function hereStop(request: Request, haltHere: SpeechRouteDeps["haltHere"]): Promise<Response> {
  const body = await jsonBody(request);
  const ref = body ? pageRef(body) : null;
  if (!ref) return errorResponse("invalid_request", "expected { ref } of letters, digits and dashes", 400);
  try {
    await haltHere(ref);
  } catch (error) {
    return errorResponse("speech_unreachable", `the speech process did not take the stop: ${String(error)}`, 502);
  }
  return new Response(null, { status: 204 });
}

export function createSpeechRoutes(deps: Partial<SpeechRouteDeps> = {}): RouteHandler {
  const { speak, halt, speakHere, haltHere } = { ...LIVE, ...deps };
  return (request, url) => {
    if (request.method !== "POST") return undefined;
    if (url.pathname === SPEECH_READ_ROUTE) return read(request, speak);
    if (url.pathname === SPEECH_STOP_ROUTE) return stop(halt);
    if (url.pathname === SPEECH_HERE_ROUTE) return here(request, speakHere);
    if (url.pathname === SPEECH_HERE_STOP_ROUTE) return hereStop(request, haltHere);
    return undefined;
  };
}
