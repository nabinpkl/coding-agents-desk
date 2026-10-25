// A one-minute test of the spoken audio channel: does a locked iPhone keep playing a live stream?
//
//   GET /api/audio/test-stream  -> audio/aac, 60 seconds, paced in real time
//
// Silence, with three spoken messages part-way through. Paced rather than sent at once, so the
// phone cannot buffer the minute ahead and finish it on a schedule of its own: each message
// arrives only as its moment comes, the way a forwarded agent message would.

import { AUDIO_TEST_STREAM_ROUTE } from "@agentdesk/agent-feed-wire";
import { splitAdtsFrames, type AdtsFrame } from "@/audio/adtsFrames";
import { speakToAdts } from "@/audio/speechAudio";
import { errorResponse } from "@/http/protocol/httpResponses";
import type { RouteHandler } from "@/http/protocol/route";

const LENGTH_MS = 60_000;

/**
 * Sent ahead of the clock, so playback starts soon and a late wake-up does not run it dry. Chrome
 * waits for a few seconds of a stream before it starts: with 2s sent ahead it started after about
 * six seconds of waiting.
 */
const LEAD_MS = 6_000;

/** The longest the pacer sleeps; a frame lasts 46ms, so this sends five or so at a time. */
const TICK_MS = 250;

const MESSAGES = [
  { atMs: 15_000, text: "Audio channel test. Fifteen seconds in. If your phone is locked, the stream survived." },
  { atMs: 35_000, text: "Thirty five seconds. Still playing." },
  { atMs: 55_000, text: "Fifty five seconds. The test ends in five seconds." },
];

type Scheduled = { atMs: number; bytes: Uint8Array };

/** Every frame of the minute, with the moment it starts playing. */
async function buildTimeline(): Promise<Scheduled[]> {
  const [silenceBytes, spokenMessages] = await Promise.all([
    speakToAdts("[[slnc 500]]"),
    Promise.all(MESSAGES.map(async (message) => ({ atMs: message.atMs, bytes: await speakToAdts(message.text) }))),
  ]);
  // One frame from the middle of half a second of encoded silence, repeated for every gap: the same
  // encoder and settings as the speech, so the decoder never sees the stream change shape.
  const silenceFrames = splitAdtsFrames(silenceBytes);
  const silence = silenceFrames[Math.floor(silenceFrames.length / 2)];
  if (!silence) throw new Error("say produced no frames for silence");

  const timeline: Scheduled[] = [];
  let clockMs = 0;
  const append = (frame: AdtsFrame) => {
    timeline.push({ atMs: clockMs, bytes: frame.bytes });
    clockMs += frame.durationMs;
  };
  const silenceUntil = (untilMs: number) => {
    while (clockMs < untilMs) append(silence);
  };
  for (const message of spokenMessages) {
    silenceUntil(message.atMs);
    for (const frame of splitAdtsFrames(message.bytes)) append(frame);
  }
  silenceUntil(LENGTH_MS);
  return timeline;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const joined = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  return joined;
}

/** Hands out the timeline as the wall clock reaches each frame, less the lead. */
function pacedStream(timeline: Scheduled[], label: string): ReadableStream<Uint8Array> {
  let startedAt = 0;
  let next = 0;
  return new ReadableStream<Uint8Array>({
    start() {
      startedAt = Date.now();
      console.log(`[audio] ${label}: started, ${timeline.length} frames`);
    },
    async pull(controller) {
      // A poll on the clock, justified: what decides when the next frame is due is time itself,
      // and nothing else could announce it. Pull-driven, so a reader that stops pulling stops it.
      for (;;) {
        if (next >= timeline.length) {
          console.log(`[audio] ${label}: sent to the end in ${Math.round((Date.now() - startedAt) / 1000)}s`);
          controller.close();
          return;
        }
        const dueMs = Date.now() - startedAt + LEAD_MS;
        const due: Uint8Array[] = [];
        let upcoming = timeline[next];
        while (upcoming && upcoming.atMs <= dueMs) {
          due.push(upcoming.bytes);
          next += 1;
          upcoming = timeline[next];
        }
        if (due.length > 0) {
          controller.enqueue(concat(due));
          return;
        }
        if (upcoming) await Bun.sleep(Math.max(1, Math.min(TICK_MS, upcoming.atMs - dueMs)));
      }
    },
    cancel() {
      console.log(`[audio] ${label}: reader left at ${Math.round((Date.now() - startedAt) / 1000)}s`);
    },
  });
}

async function serveTestStream(request: Request): Promise<Response> {
  let timeline: Scheduled[];
  try {
    timeline = await buildTimeline();
  } catch (error) {
    return errorResponse("speech_failed", error instanceof Error ? error.message : String(error), 500);
  }
  // Which reader this is, for the log: a phone opens the same stream more than once while it probes.
  const label = `test stream ${request.headers.get("range") ?? "no range"} ${request.headers.get("user-agent")?.slice(0, 60) ?? ""}`;
  return new Response(pacedStream(timeline, label), {
    headers: { "content-type": "audio/aac", "cache-control": "no-store" },
  });
}

export function createAudioRoutes(): RouteHandler {
  return (request, url) => {
    if (url.pathname === AUDIO_TEST_STREAM_ROUTE && request.method === "GET") return serveTestStream(request);
    return undefined;
  };
}
