// The audio channel's stream: silence, and whatever agents say, for as long as somebody listens.
//
//   GET /api/audio/stream  -> audio/aac, paced in real time, until the listener leaves
//
// One long-lived stream rather than a clip per message: a phone starts playback only from a tap,
// and a clip that ends can let iOS close the audio session, after which the next one does not start
// on a locked screen. So this never ends on its own; the listener ends it. Messages
// (`POST /api/audio/speak`, `audioChannel.ts`) play at the stream's next gap.
//
// Paced rather than sent as fast as it is read, so what the phone plays is what was said a moment
// ago, not something it buffered minutes earlier. Silence is sent as real frames, not nothing: a
// stream that sends nothing is one a player gives up on.

import { AUDIO_STREAM_ROUTE } from "@agentdesk/agent-feed-wire";
import { splitAdtsFrames, type AdtsFrame } from "@/audio/adtsFrames";
import { audioChannel, createAudioSpeakRoute, type AudioChannel } from "@/audio/audioChannel";
import { speakToAdts } from "@/audio/speechAudio";
import { errorResponse } from "@/http/protocol/httpResponses";
import type { RouteHandler } from "@/http/protocol/route";

/**
 * Sent ahead of the clock, so playback starts soon and a late wake-up does not run it dry. Chrome
 * waits for a few seconds of a stream before it starts: with 2s sent ahead it started after about
 * six seconds of waiting. It is also most of a message's delay: a message joins the stream here,
 * this far ahead of what is being heard, so it is heard about this much later than it was sent.
 */
const LEAD_MS = 6_000;

/** The longest the pacer sleeps; a frame lasts 46ms, so this sends five or so at a time. */
const TICK_MS = 250;

/**
 * One frame from the middle of half a second of encoded silence, repeated for every gap: the same
 * encoder and settings as the speech, so the decoder never sees the stream change shape. Made once
 * per process; a failure is dropped so the next stream tries again.
 */
let silenceFrame: Promise<AdtsFrame> | null = null;
function silence(): Promise<AdtsFrame> {
  if (silenceFrame) return silenceFrame;
  const making = speakToAdts("[[slnc 500]]").then((bytes) => {
    const frames = splitAdtsFrames(bytes);
    const middle = frames[Math.floor(frames.length / 2)];
    if (!middle) throw new Error("say produced no frames for silence");
    return middle;
  });
  silenceFrame = making;
  making.catch(() => (silenceFrame = null));
  return making;
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

function seconds(ms: number): string {
  return `${Math.round(ms / 1000)}s`;
}

/**
 * Silence, with each message spliced in at the next frame boundary once it arrives.
 *
 * `clockMs` is the stream position of the next frame to send. A frame goes out once the wall
 * clock, plus the lead, reaches it.
 */
function pacedStream(gap: AdtsFrame, label: string, stopped: AbortSignal, channel: AudioChannel) {
  let connectedAt = 0;
  let clockMs = 0;
  let spoken = 0;
  // Messages waiting for this stream's next gap, oldest first.
  const messages: AdtsFrame[][] = [];
  const unlisten = channel.listen((frames) => messages.push(frames));
  let finished = false;
  const finish = (how: string) => {
    if (finished) return;
    finished = true;
    unlisten();
    console.log(`[audio] ${label}: ${how} after ${seconds(Date.now() - connectedAt)}, ${spoken} message(s) played`);
  };

  async function send(controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> {
    // A poll on the clock, justified: what decides when the next frame is due is time itself,
    // and nothing else could announce it. Pull-driven, so a reader that stops pulling stops it.
    for (;;) {
      if (finished) return;
      const dueMs = Date.now() - connectedAt + LEAD_MS;
      if (clockMs > dueMs) {
        await Bun.sleep(Math.max(1, Math.min(TICK_MS, clockMs - dueMs)));
        continue;
      }
      const chunk: Uint8Array[] = [];
      while (clockMs <= dueMs) {
        const message = messages.shift();
        for (const frame of message ?? [gap]) {
          chunk.push(frame.bytes);
          clockMs += frame.durationMs;
        }
        if (message) spoken += 1;
      }
      controller.enqueue(concat(chunk));
      return;
    }
  }

  return new ReadableStream<Uint8Array>({
    start(controller) {
      connectedAt = Date.now();
      console.log(`[audio] ${label}: listening`);
      // The listener leaving, as either side reports it: Bun cancels the stream, or the request's
      // signal aborts. Whichever comes first takes the stream out of the channel.
      stopped.addEventListener("abort", () => {
        finish("listener left (request aborted)");
        try {
          controller.close();
        } catch {
          // Already closed or cancelled: the other report got there first.
        }
      });
    },
    async pull(controller) {
      try {
        await send(controller);
      } catch (error) {
        finish(`failed: ${error instanceof Error ? error.message : String(error)}`);
        throw error;
      }
    },
    cancel() {
      finish("listener left (stream cancelled)");
    },
  });
}

async function serveStream(request: Request): Promise<Response> {
  let gap: AdtsFrame;
  try {
    gap = await silence();
  } catch (error) {
    return errorResponse("speech_failed", error instanceof Error ? error.message : String(error), 500);
  }
  // Which reader this is, for the log: a phone opens the same stream more than once while it probes.
  const label = `stream ${request.headers.get("range") ?? "no range"} ${request.headers.get("user-agent")?.slice(0, 60) ?? ""}`;
  return new Response(pacedStream(gap, label, request.signal, audioChannel), {
    headers: { "content-type": "audio/aac", "cache-control": "no-store" },
  });
}

export function createAudioRoutes(): RouteHandler {
  const speak = createAudioSpeakRoute(audioChannel);
  return (request, url, server) => {
    if (url.pathname === AUDIO_STREAM_ROUTE && request.method === "GET") return serveStream(request);
    return speak(request, url, server);
  };
}
