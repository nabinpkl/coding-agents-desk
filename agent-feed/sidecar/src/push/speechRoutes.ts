// The panel asking to hear something on this Mac's speech process.
//
//   POST /api/speech/read       <- { text }  -> { listeners, durationMs }, or 409 nobody_listening / stopped
//   POST /api/speech/stop       -> 204 once the reply being read is stopped
//   POST /api/speech/here       <- { text, ref }  -> 200, the speech as float32 PCM, streamed as it is made
//   POST /api/speech/here/stop  <- { ref }  -> 204 once that speech is no longer being made
//   GET  /api/speech/tuning     -> { tuning, ranges }; POST <- some of tuning -> the same, as the speech
//                                  process keeps them (its `/processing`): passed through both ways
//   POST /api/speech/say        <- { session, text }  -> { listeners, durationMs, speaker, voice }, or 409
//                                  nobody_listening / replaced, 404 unknown_session
//
// The feed's two buttons on a reply. Broadcast (`read`) says it to Agent Radio's listeners, through
// the same queue as the sessions' own announcements (`sessionSpeech.ts`), so the two never talk over
// each other. The speaker (`here`) hands the speech back to the page that asked, to play on its own
// device, outside that queue. Both are this Mac's routes whichever machine the reply came from:
// only this Mac has the voice.
//
// And a session telling the listener something itself (`say`, from `tools/agent-radio-say.sh`): said
// as that session, as the Bot holding it on the canvas and in the voice it has there, through the
// same queue.

import {
  AUDIO_SPEAK_MAX_CHARS,
  SPEECH_HERE_ROUTE,
  SPEECH_HERE_STOP_ROUTE,
  SPEECH_READ_ROUTE,
  SPEECH_SAMPLE_RATE,
  SPEECH_SAY_ROUTE,
  SPEECH_STOP_ROUTE,
  SPEECH_TUNING_ROUTE,
  type BotSessionRef,
  type SpeechReadResponse,
  type SpeechSayResponse,
} from "@agentdesk/agent-feed-wire";
import { speechPort } from "@/audio/audioConfig";
import { normalizeSessionRef } from "@/bots/botCommands";
import type { BotStore } from "@/bots/botStore";
import { errorResponse, jsonResponse } from "@/http/protocol/httpResponses";
import type { RouteHandler } from "@/http/protocol/route";
import {
  readAloud,
  sayForSession,
  speechForPage,
  stopReading,
  stopSpeechForPage,
  type SpeechOutcome,
} from "@/push/sessionSpeech";
import { createSessionVoices } from "@/push/sessionVoices";
import { curatingBot } from "@/push/turnFinishedNotifier";
import { catalogReady, findSession } from "@/transcripts/catalog/transcriptCatalog";

/** A reply this long is a paste, not something to read out; the reader cuts long ones anyway. */
const MAX_BODY_CHARS = 200_000;

/** A page's name for its playback. Prefixed before it reaches the speech process, so it cannot name a Bot's message. */
const PAGE_REF = /^[a-z0-9-]{1,64}$/i;

/** The speech process's `/processing`, read (no body) or changed (a body of settings). */
export type SpeechTune = (changes: Record<string, unknown> | null) => Promise<Response>;

/**
 * A session's own message said as it: what became of it, who it was said as and in which voice;
 * `unknown-session` for one the catalog does not have, null when nothing in the text can be said.
 */
export type SessionSay = (
  ref: BotSessionRef,
  text: string,
) => Promise<{ outcome: SpeechOutcome; speaker: string; voice: string | null } | "unknown-session" | null>;

export type SpeechRouteDeps = {
  speak: typeof readAloud;
  halt: typeof stopReading;
  speakHere: typeof speechForPage;
  haltHere: typeof stopSpeechForPage;
  tune: SpeechTune;
  sayAs: SessionSay;
};

/** The Bot store, which knows which Bot holds a session and gives its sessions their voices. */
export type SpeechBots = Pick<BotStore, "snapshot" | "mutate">;

/**
 * Says a session's message as the Bot holding it on the canvas, in the voice it has there (given it
 * now if it has none), or as itself in the voice in use when no Bot does.
 */
export function sayAsSession(bots: SpeechBots): SessionSay {
  const voices = createSessionVoices(bots);
  return async (ref, text) => {
    // After a restart the catalog takes a few seconds to read every session; one it has not reached
    // yet is not unknown.
    await catalogReady();
    const session = findSession(ref.source, ref.sessionId);
    if (!session) return "unknown-session";
    const key = `${ref.source}:${ref.sessionId}`;
    const bot = curatingBot((await bots.snapshot()).bots, key);
    const voice = bot
      ? await voices.voiceOf(bot.botId, key).catch((error: unknown) => {
          console.error(`[speech] could not give ${bot.name}'s session a voice`, error);
          return null;
        })
      : null;
    const said = await sayForSession(bot, session, text, voice);
    return said && { ...said, voice };
  };
}

const tuneOnMac: SpeechTune = (changes) =>
  fetch(`http://127.0.0.1:${speechPort()}/processing`, {
    method: changes ? "POST" : "GET",
    ...(changes ? { headers: { "content-type": "application/json" }, body: JSON.stringify(changes) } : {}),
  });

const LIVE: Omit<SpeechRouteDeps, "sayAs"> = {
  speak: readAloud,
  halt: stopReading,
  speakHere: speechForPage,
  haltHere: stopSpeechForPage,
  tune: tuneOnMac,
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

/** `session` as `<source>:<session id>`, the way `tools/` and the hub name a session; null when it is not one. */
function sessionOf(body: Record<string, unknown>): BotSessionRef | null {
  const value = body.session;
  const colon = typeof value === "string" ? value.indexOf(":") : -1;
  if (typeof value !== "string" || colon <= 0) return null;
  try {
    return normalizeSessionRef({ source: value.slice(0, colon), sessionId: value.slice(colon + 1) });
  } catch {
    return null;
  }
}

async function say(request: Request, sayAs: SessionSay): Promise<Response> {
  const body = await jsonBody(request);
  if (!body) return errorResponse("invalid_request", "body is not JSON", 400);
  const ref = sessionOf(body);
  const text = typeof body.text === "string" && body.text.trim() ? body.text : null;
  if (!ref || !text) {
    return errorResponse("invalid_request", 'expected { session: "<source>:<session id>", text }', 400);
  }
  if (text.length > AUDIO_SPEAK_MAX_CHARS) {
    return errorResponse("message_too_long", `text is over ${AUDIO_SPEAK_MAX_CHARS} characters`, 413);
  }
  const said = await sayAs(ref, text);
  if (said === "unknown-session") {
    return errorResponse("unknown_session", `the catalog has no session ${ref.source}:${ref.sessionId}`, 404);
  }
  if (!said) return errorResponse("nothing_to_say", "nothing in that text can be said out loud", 422);
  const { outcome, speaker, voice } = said;
  if (outcome.said) {
    return jsonResponse({
      listeners: outcome.listeners,
      durationMs: outcome.durationMs,
      speaker,
      voice,
    } satisfies SpeechSayResponse);
  }
  if (outcome.why === "nobody-listening") {
    return errorResponse("nobody_listening", "nothing is listening on the speech process's stream", 409);
  }
  if (outcome.why === "replaced") {
    return errorResponse("replaced", "the session's next message took its place before it was said", 409);
  }
  if (outcome.why === "stopped") return errorResponse("stopped", "it was stopped before it finished", 409);
  return errorResponse("speech_failed", "the speech process could not say it", 502);
}

/** The settings as the speech process answers them: its own 400 names the setting it refused. */
async function tuning(request: Request, tune: SpeechRouteDeps["tune"]): Promise<Response> {
  let changes: Record<string, unknown> | null = null;
  if (request.method === "POST") {
    changes = await jsonBody(request);
    if (!changes) return errorResponse("invalid_request", "body is not JSON", 400);
  }
  let upstream: Response;
  try {
    upstream = await tune(changes);
  } catch (error) {
    return errorResponse("speech_unreachable", `the speech process did not answer: ${String(error)}`, 502);
  }
  return new Response(await upstream.text(), {
    status: upstream.status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

/**
 * The speech routes. `bots` is the live Bot store, which `say` needs to know who a session speaks
 * as; a test hands `sayAs` instead.
 */
export function createSpeechRoutes(deps: Partial<SpeechRouteDeps> & { bots?: SpeechBots } = {}): RouteHandler {
  const { speak, halt, speakHere, haltHere, tune } = { ...LIVE, ...deps };
  const sayAs = deps.sayAs ?? (deps.bots ? sayAsSession(deps.bots) : null);
  return (request, url) => {
    if (url.pathname === SPEECH_TUNING_ROUTE && (request.method === "GET" || request.method === "POST")) {
      return tuning(request, tune);
    }
    if (request.method !== "POST") return undefined;
    if (url.pathname === SPEECH_READ_ROUTE) return read(request, speak);
    if (url.pathname === SPEECH_STOP_ROUTE) return stop(halt);
    if (url.pathname === SPEECH_HERE_ROUTE) return here(request, speakHere);
    if (url.pathname === SPEECH_HERE_STOP_ROUTE) return hereStop(request, haltHere);
    if (url.pathname === SPEECH_SAY_ROUTE) {
      if (sayAs) return say(request, sayAs);
      return errorResponse("speech_unwired", "the speech routes were made without the Bot store", 500);
    }
    return undefined;
  };
}
