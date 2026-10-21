// Experiment, not yet part of the channel: speech the Mac makes, pushed to a page on the phone that
// mixes it with the noise itself, which may become how Agent Radio speaks. The page is
// `packages/AgentPanel/Web/public/experiments/local-test.html?push=1`; this is its server half, in the
// audio process so a sidecar restart leaves the page's streams open.
//
// While it runs it takes over `POST /api/audio/speak`: an agent's message goes to the speech process
// (`agent-feed/speech/speech_server.py`) and on to every page listening there, not to Agent Radio's
// AAC stream. The sidecar's own speech (`push/sessionSpeech.ts`) already goes to the speech process.

import { AUDIO_SPEAK_MAX_CHARS, AUDIO_SPEAK_ROUTE } from "@agentdesk/agent-feed-wire";
import { speakableText } from "@/audio/audioChannel";
import { speechPort } from "@/audio/audioConfig";
import { errorResponse, jsonResponse } from "@/http/protocol/httpResponses";
import type { RouteHandler } from "@/http/protocol/route";

const SPEECH_SERVER = `http://127.0.0.1:${speechPort()}/`;

/**
 * `GET /api/audio/local-test`: the page, served here with the two headers that make a page
 * cross-origin isolated, which a browser requires before it lets a page run WebAssembly on several
 * threads (the page's on-phone voices). The dev server sends no such headers, and adding them there
 * would change every panel page.
 */
const LOCAL_TEST_ROUTE = "/api/audio/local-test";
const LOCAL_TEST_PAGE = new URL(
  "../../../../packages/AgentPanel/Web/public/experiments/local-test.html",
  import.meta.url,
);

async function isolatedTestPage(): Promise<Response> {
  return new Response(await Bun.file(LOCAL_TEST_PAGE).text(), {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "cross-origin-opener-policy": "same-origin",
      "cross-origin-embedder-policy": "require-corp",
    },
  });
}

/**
 * `/api/audio/kitten-<route>`, passed through to the speech process as it is: `listen` is its push
 * stream, `events` its control stream, `ack` the page's timings, `cancel` stops a message, `ping` a
 * round trip to time, `speed` how fast it speaks. Any other name is not this experiment's, and is
 * left for another handler.
 */
const KITTEN_PREFIX = "/api/audio/kitten-";
const SPEECH_ROUTES = new Set(["listen", "events", "ack", "cancel", "ping", "speed"]);

async function forwardToSpeech(request: Request, route: string, search: string): Promise<Response> {
  let answer: Response;
  try {
    answer = await fetch(SPEECH_SERVER + route + search, {
      method: request.method,
      body: request.method === "POST" ? await request.arrayBuffer() : undefined,
      signal: request.signal,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return errorResponse("speech_unreachable", `${SPEECH_SERVER} did not answer: ${reason}`, 502);
  }
  return new Response(answer.body, {
    status: answer.status,
    headers: { "content-type": "application/octet-stream", "cache-control": "no-store" },
  });
}

/**
 * `POST /api/audio/speak`, taken over: checked as Agent Radio checks it, and answered in the same
 * shape, `{ listeners, durationMs }` or 409 `nobody_listening`, once the whole message is made.
 */
async function speakOnPush(request: Request): Promise<Response> {
  let text: unknown;
  try {
    text = ((await request.json()) as { text?: unknown } | null)?.text;
  } catch {
    return errorResponse("invalid_message", "body is not a JSON object", 400);
  }
  if (typeof text !== "string" || speakableText(text) === "") {
    return errorResponse("invalid_message", "expected { text } with something to say", 400);
  }
  if (text.length > AUDIO_SPEAK_MAX_CHARS) {
    return errorResponse("message_too_long", `text is over ${AUDIO_SPEAK_MAX_CHARS} characters`, 413);
  }
  let answer: Response;
  try {
    answer = await fetch(`${SPEECH_SERVER}say`, {
      method: "POST",
      body: JSON.stringify({ text: speakableText(text) }),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return errorResponse("speech_failed", `the speech process at ${SPEECH_SERVER} did not answer: ${reason}`, 502);
  }
  const body = await answer.text();
  console.log(`[audio] speak on push ${JSON.stringify(text.slice(0, 60))}: ${answer.status} ${body.slice(0, 120)}`);
  return new Response(body, { status: answer.status, headers: { "content-type": "application/json" } });
}

/**
 * What a test page reports about itself (its state and its log), so it can be read here rather than
 * off the phone's screen: `POST` adds one, `GET` returns the latest.
 */
const TEST_REPORTS_ROUTE = "/api/audio/test-reports";
const REPORTS_KEPT = 300;
const reports: unknown[] = [];

async function keepReport(request: Request): Promise<Response> {
  const text = await request.text();
  if (text.length > 8_000) return errorResponse("report_too_large", "a report is at most 8000 characters", 413);
  let report: unknown;
  try {
    report = JSON.parse(text);
  } catch {
    return errorResponse("invalid_report", "a report is a JSON object", 400);
  }
  reports.push({ at: new Date().toISOString(), ...(report as object) });
  if (reports.length > REPORTS_KEPT) reports.splice(0, reports.length - REPORTS_KEPT);
  return new Response(null, { status: 204 });
}

export function createSpeechPushExperimentRoutes(): RouteHandler {
  return (request, url) => {
    if (url.pathname === AUDIO_SPEAK_ROUTE && request.method === "POST") return speakOnPush(request);
    if (url.pathname.startsWith(KITTEN_PREFIX)) {
      const route = url.pathname.slice(KITTEN_PREFIX.length);
      return SPEECH_ROUTES.has(route) ? forwardToSpeech(request, route, url.search) : undefined;
    }
    if (url.pathname === LOCAL_TEST_ROUTE && request.method === "GET") return isolatedTestPage();
    if (url.pathname === TEST_REPORTS_ROUTE) {
      return request.method === "POST" ? keepReport(request) : jsonResponse({ reports });
    }
    return undefined;
  };
}
