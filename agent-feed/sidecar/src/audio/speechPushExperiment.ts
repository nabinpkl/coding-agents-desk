// Experiment, not yet part of the channel: speech the Mac makes, pushed to a page on the phone that
// mixes it with the noise itself, which may become how Agent Radio speaks. The page is
// `packages/AgentPanel/Web/public/experiments/local-test.html?push=1`; this is its server half, in the
// audio process so a sidecar restart leaves the page's streams open.
//
// While it runs it takes over `POST /api/audio/speak`: an agent's message goes to the speech process
// (`agent-feed/speech/speech_server.py`) and on to every page listening there, not to Agent Radio's
// AAC stream. The sidecar's own speech (`push/sessionSpeech.ts`) already goes to the speech process.

import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
 * `/api/audio/speech-<route>`, passed through to the speech process as it is: `listen` is its push
 * stream, `events` its control stream, `ack` the page's timings, `cancel` stops a message, `ping` a
 * round trip to time, `speed` how fast the page plays speech, `voices` the voices it can speak in and
 * `voice` the one it switches to. Any other name is not the speech process's, and is left for
 * another handler.
 */
const SPEECH_PREFIX = "/api/audio/speech-";
const SPEECH_ROUTES = new Set(["listen", "events", "ack", "cancel", "ping", "speed", "voices", "voice"]);

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
    headers: {
      "content-type": answer.headers.get("content-type") ?? "application/octet-stream",
      "cache-control": "no-store",
    },
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

/**
 * The page's mic, recorded on the Mac between its Record and Stop, to hear what Apple's dictation was
 * given when it heard nothing or the wrong thing. `POST /api/audio/mic-record?rec=<id>` appends a
 * piece (float32 mono, as the page's mic gives it); `POST /api/audio/mic-record-end?rec=<id>&rate=<hz>`
 * <- {heard: [...]} makes `<id>.wav` and `<id>.txt` (what dictation heard, at what second);
 * `GET /api/audio/mic-recording?rec=<id>` plays it back. Kept in the system's temp folder.
 */
const MIC_RECORDINGS = join(tmpdir(), "agentdesk-mic-recordings");
const MIC_RECORD_ROUTE = "/api/audio/mic-record";
const MIC_RECORD_END_ROUTE = "/api/audio/mic-record-end";
const MIC_RECORDING_ROUTE = "/api/audio/mic-recording";
const RECORDING_ID = /^[a-z0-9-]{1,40}$/;

function recordingId(url: URL): string | null {
  const id = url.searchParams.get("rec") ?? "";
  return RECORDING_ID.test(id) ? id : null;
}

async function recordPiece(request: Request, id: string): Promise<Response> {
  const piece = new Uint8Array(await request.arrayBuffer());
  if (piece.length % 4 !== 0) return errorResponse("invalid_piece", "a piece is whole float32 samples", 400);
  await mkdir(MIC_RECORDINGS, { recursive: true });
  await appendFile(join(MIC_RECORDINGS, `${id}.f32`), piece);
  return new Response(null, { status: 204 });
}

/** 16-bit mono WAV at `rate`, from float32 samples. */
function wavOf(samples: Float32Array, rate: number): Uint8Array {
  const out = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(out.buffer);
  const text = (at: number, value: string) =>
    [...value].forEach((char, i) => view.setUint8(at + i, char.charCodeAt(0)));
  text(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, i) =>
    view.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, sample)) * 32767), true),
  );
  return out;
}

async function endRecording(request: Request, url: URL, id: string): Promise<Response> {
  const rate = Number(url.searchParams.get("rate"));
  if (!Number.isInteger(rate) || rate < 8000 || rate > 96000) {
    return errorResponse("invalid_rate", "rate is the mic's sample rate, 8000 to 96000", 400);
  }
  const raw = join(MIC_RECORDINGS, `${id}.f32`);
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(raw));
  } catch {
    return errorResponse("no_recording", `nothing was recorded as ${id}`, 404);
  }
  const samples = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  const heard = ((await request.json().catch(() => null)) as { heard?: unknown } | null)?.heard;
  const lines = Array.isArray(heard) ? heard.filter((line) => typeof line === "string") : [];
  await writeFile(join(MIC_RECORDINGS, `${id}.wav`), wavOf(samples, rate));
  await writeFile(join(MIC_RECORDINGS, `${id}.txt`), `${lines.join("\n")}\n`);
  await rm(raw, { force: true });
  const seconds = Math.round((samples.length / rate) * 10) / 10;
  console.log(
    `[audio] mic recording ${id}: ${seconds} s at ${rate} Hz, ${lines.length} dictation line(s), in ${MIC_RECORDINGS}`,
  );
  return jsonResponse({ seconds, url: `${MIC_RECORDING_ROUTE}?rec=${id}` });
}

async function playRecording(id: string): Promise<Response> {
  try {
    const wav = await readFile(join(MIC_RECORDINGS, `${id}.wav`));
    return new Response(wav, { headers: { "content-type": "audio/wav", "cache-control": "no-store" } });
  } catch {
    return errorResponse("no_recording", `no recording ${id}`, 404);
  }
}

/**
 * Which session the page's dictation streams into, chosen from either end: the page's own picker,
 * or the mic on a session's composer in the panel. Held here rather than in either, so both read one
 * answer, and here rather than in the sidecar, which forgets on every save. A session id alone,
 * because ids are unique across machines and the page finds which machine lists it.
 *
 * `GET /api/audio/dictation-target` answers `{sessionId, mics}` (sessionId null: nowhere), `POST`
 * with `{sessionId}` sets it, and `GET …/stream` sends it as each reader connects and again on every
 * change. `mics` is how many phone pages have their mic on, so the panel's mic can say whether
 * anything is listening to stream.
 */
const DICTATION_TARGET_ROUTE = "/api/audio/dictation-target";
const DICTATION_TARGET_STREAM_ROUTE = "/api/audio/dictation-target/stream";
/**
 * `POST {page, on}`: a dictation page's mic is on or off. The page says so on each change, each time
 * its stream connects (`…/stream?page=<page>`), and as it closes. One that vanishes without saying
 * goes with its stream, when that is cancelled or stops taking beats.
 */
const DICTATION_MIC_ROUTE = "/api/audio/dictation-target/mic";
const SESSION_ID = /^[A-Za-z0-9-]{1,80}$/;
/** A page names itself with a random UUID. */
const PAGE_ID = /^[A-Za-z0-9-]{1,80}$/;
const encoder = new TextEncoder();
let dictationTarget: string | null = null;
/** Every reader of the stream, with the dictation page it is, or null for the panel. */
const targetReaders = new Map<ReadableStreamDefaultController<Uint8Array>, string | null>();
/** The pages whose mic is on. */
const micsOn = new Set<string>();

/** Forgets a reader, and its page's mic once no stream of that page is left; true if a mic went. */
function dropReader(reader: ReadableStreamDefaultController<Uint8Array>): boolean {
  const page = targetReaders.get(reader);
  targetReaders.delete(reader);
  if (!page || !micsOn.has(page) || [...targetReaders.values()].includes(page)) return false;
  micsOn.delete(page);
  console.log(`[audio] dictation mic of page ${page} gone with its stream (${micsOn.size} listening)`);
  return true;
}

function sendToReaders(bytes: Uint8Array): void {
  let micGone = false;
  for (const reader of targetReaders.keys()) {
    // Bun cancels a stream whose reader closed it, but not one that simply went quiet, so a reader
    // that stopped taking what it is sent is dropped here: one still there takes each beat as it
    // comes, and one that is gone lets them pile up.
    if ((reader.desiredSize ?? 0) < -3) {
      micGone = dropReader(reader) || micGone;
      continue;
    }
    try {
      reader.enqueue(bytes);
    } catch {
      micGone = dropReader(reader) || micGone;
    }
  }
  if (micGone) sendToReaders(targetEvent());
}

// A beat, not a poll: it keeps an idle stream from being closed on the way, and is how a reader that
// left is noticed (above).
setInterval(() => sendToReaders(encoder.encode(": beat\n\n")), 20_000).unref();

function targetState() {
  return { sessionId: dictationTarget, mics: micsOn.size };
}

function targetEvent(): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(targetState())}\n\n`);
}

function streamTarget(url: URL): Response {
  const asked = url.searchParams.get("page");
  const page = asked !== null && PAGE_ID.test(asked) ? asked : null;
  let mine: ReadableStreamDefaultController<Uint8Array> | null = null;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      mine = controller;
      controller.enqueue(targetEvent());
      targetReaders.set(controller, page);
    },
    cancel() {
      if (mine && dropReader(mine)) sendToReaders(targetEvent());
    },
  });
  return new Response(body, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform" },
  });
}

async function chooseTarget(request: Request): Promise<Response> {
  let sessionId: unknown;
  try {
    ({ sessionId } = (await request.json()) as { sessionId?: unknown });
  } catch {
    return errorResponse("invalid_target", "send {sessionId}, a session id or null", 400);
  }
  if (sessionId !== null && (typeof sessionId !== "string" || !SESSION_ID.test(sessionId))) {
    return errorResponse("invalid_target", "sessionId is a session id or null", 400);
  }
  if (sessionId !== dictationTarget) {
    dictationTarget = sessionId;
    console.log(`[audio] dictation streams to ${sessionId ?? "nowhere"}`);
    sendToReaders(targetEvent());
  }
  return jsonResponse(targetState());
}

async function setMic(request: Request): Promise<Response> {
  let page: unknown;
  let on: unknown;
  try {
    ({ page, on } = (await request.json()) as { page?: unknown; on?: unknown });
  } catch {
    return errorResponse("invalid_mic", "send {page, on}", 400);
  }
  if (typeof page !== "string" || !PAGE_ID.test(page) || typeof on !== "boolean") {
    return errorResponse("invalid_mic", "page is letters, digits and dashes, and on is true or false", 400);
  }
  // A mic counts only while its page's stream is open, which is what notices the page going.
  if (on && ![...targetReaders.values()].includes(page)) {
    return errorResponse("no_stream", `page ${page} has no dictation-target stream open`, 409);
  }
  if (on !== micsOn.has(page)) {
    if (on) micsOn.add(page);
    else micsOn.delete(page);
    console.log(`[audio] dictation mic turned ${on ? "on" : "off"} by page ${page} (${micsOn.size} listening)`);
    sendToReaders(targetEvent());
  }
  return jsonResponse(targetState());
}

function dictationTargetRoutes(request: Request, url: URL): Promise<Response> | Response | undefined {
  if (url.pathname === DICTATION_TARGET_STREAM_ROUTE && request.method === "GET") return streamTarget(url);
  if (url.pathname === DICTATION_MIC_ROUTE && request.method === "POST") return setMic(request);
  if (url.pathname !== DICTATION_TARGET_ROUTE) return undefined;
  if (request.method === "POST") return chooseTarget(request);
  return request.method === "GET" ? jsonResponse(targetState()) : undefined;
}

function micRecordingRoutes(request: Request, url: URL): Promise<Response> | undefined {
  const routes = [MIC_RECORD_ROUTE, MIC_RECORD_END_ROUTE, MIC_RECORDING_ROUTE];
  if (!routes.includes(url.pathname)) return undefined;
  const id = recordingId(url);
  if (!id) return Promise.resolve(errorResponse("invalid_recording", "rec is letters, digits and dashes", 400));
  if (url.pathname === MIC_RECORDING_ROUTE) return request.method === "GET" ? playRecording(id) : undefined;
  if (request.method !== "POST") return undefined;
  return url.pathname === MIC_RECORD_ROUTE ? recordPiece(request, id) : endRecording(request, url, id);
}

export function createSpeechPushExperimentRoutes(): RouteHandler {
  return (request, url) => {
    if (url.pathname === AUDIO_SPEAK_ROUTE && request.method === "POST") return speakOnPush(request);
    if (url.pathname.startsWith(SPEECH_PREFIX)) {
      const route = url.pathname.slice(SPEECH_PREFIX.length);
      return SPEECH_ROUTES.has(route) ? forwardToSpeech(request, route, url.search) : undefined;
    }
    if (url.pathname === LOCAL_TEST_ROUTE && request.method === "GET") return isolatedTestPage();
    if (url.pathname === TEST_REPORTS_ROUTE) {
      return request.method === "POST" ? keepReport(request) : jsonResponse({ reports });
    }
    return dictationTargetRoutes(request, url) ?? micRecordingRoutes(request, url);
  };
}
