// The audio channel's stream: a bed of white noise, and whatever agents say over it, for as long as
// somebody listens.
//
//   GET /api/audio/stream?listener=<id>&noise=<level>  -> audio/aac, paced in real time
//
// One long-lived stream rather than a clip per message: a phone starts playback only from a tap,
// and a clip that ends can let iOS close the audio session, after which the next one does not start
// on a locked screen. So this never ends on its own; the listener ends it. Messages
// (`POST /api/audio/speak`, `audioChannel.ts`) play at the stream's next gap, mixed over the same
// noise, so the bed never drops out under a voice.
//
// The noise is the device's own level (`POST /api/audio/noise` changes it, read here every tick),
// 0 being silence. Paced rather than sent as fast as it is read, so what the phone plays is what
// was said a moment ago, not something it buffered minutes earlier. Silence is sent as real frames,
// not nothing: a stream that sends nothing is one a player gives up on.

import { AUDIO_STREAM_ROUTE } from "@agentdesk/agent-feed-wire";
import type { AdtsFrame } from "@/audio/adtsFrames";
import { audioChannel, createAudioChannelRoutes, type AudioChannel } from "@/audio/audioChannel";
import { clampNoiseLevel, silentSamples, withNoise } from "@/audio/pcmAudio";
import { encodeToAdts } from "@/audio/speechAudio";
import { errorResponse } from "@/http/protocol/httpResponses";
import type { RouteHandler } from "@/http/protocol/route";

/**
 * Sent ahead of the clock, so playback starts soon and a late wake-up does not run it dry. Chrome
 * waits for a few seconds of a stream before it starts: with 2s sent ahead it started after about
 * six seconds of waiting. It is also most of a message's delay, and of a noise change's: either
 * joins the stream here, this far ahead of what is being heard.
 */
const LEAD_MS = 6_000;

/** The longest the pacer sleeps; a frame lasts 46ms, so this sends five or so at a time. */
const TICK_MS = 250;

/** How long one level's noise runs before it repeats. Long enough that no pattern is heard. */
const NOISE_LOOP_SECONDS = 8;

/** A device id as the panel makes one (a UUID), or anything as plain. */
const LISTENER_ID = /^[A-Za-z0-9-]{1,64}$/;

/**
 * Each level's loop of noise, made once per process and shared by every stream at that level;
 * level 0 is a loop of silence. A failure is dropped so the next stream tries again.
 */
const noiseLoops = new Map<number, Promise<AdtsFrame[]>>();
function noiseLoop(level: number): Promise<AdtsFrame[]> {
  const known = noiseLoops.get(level);
  if (known) return known;
  const making = encodeToAdts(withNoise(silentSamples(NOISE_LOOP_SECONDS), level)).then((frames) => {
    if (frames.length === 0) throw new Error(`the encoder produced no frames for noise level ${level}`);
    return frames;
  });
  noiseLoops.set(level, making);
  making.catch(() => noiseLoops.delete(level));
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
 * The device's noise, with each message spliced in at the next frame boundary once it arrives.
 *
 * `clockMs` is the stream position of the next frame to send. A frame goes out once the wall
 * clock, plus the lead, reaches it.
 */
function pacedStream(listener: string, level: number, label: string, stopped: AbortSignal, channel: AudioChannel) {
  let connectedAt = 0;
  let clockMs = 0;
  let spoken = 0;
  let noiseIndex = 0;
  // Messages waiting for this stream's next gap, oldest first.
  const messages: AdtsFrame[][] = [];
  const unlisten = channel.listen(listener, level, (frames) => messages.push(frames));
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
      // Read each tick, so a level the device changes is heard from the next frames sent.
      const noise = await noiseLoop(channel.level(listener));
      if (finished) return;
      const chunk: Uint8Array[] = [];
      const append = (frame: AdtsFrame) => {
        chunk.push(frame.bytes);
        clockMs += frame.durationMs;
      };
      while (clockMs <= dueMs) {
        const message = messages.shift();
        if (message) {
          spoken += 1;
          message.forEach(append);
          continue;
        }
        const frame = noise[noiseIndex % noise.length];
        if (!frame) throw new Error("a noise loop with no frames");
        noiseIndex += 1;
        append(frame);
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

async function serveStream(request: Request, url: URL): Promise<Response> {
  // A stream with no name is its own listener: a probe from a shell, say.
  const listener = url.searchParams.get("listener") ?? crypto.randomUUID();
  if (!LISTENER_ID.test(listener)) return errorResponse("invalid_listener", "listener must be a plain id", 400);
  const noise = Number(url.searchParams.get("noise") ?? 0);
  if (!Number.isFinite(noise)) return errorResponse("invalid_noise", "noise must be a level number", 400);
  const level = clampNoiseLevel(noise);
  try {
    // Made before answering, so a broken encoder is a 500 rather than a stream that fails at once.
    await noiseLoop(level);
  } catch (error) {
    return errorResponse("speech_failed", error instanceof Error ? error.message : String(error), 500);
  }
  // Which reader this is, for the log: a phone opens the same stream more than once while it probes.
  const range = request.headers.get("range") ?? "no range";
  const label = `stream ${listener.slice(0, 8)} noise ${level} ${range} ${request.headers.get("user-agent")?.slice(0, 60) ?? ""}`;
  return new Response(pacedStream(listener, level, label, request.signal, audioChannel), {
    headers: { "content-type": "audio/aac", "cache-control": "no-store" },
  });
}

export function createAudioRoutes(): RouteHandler {
  const channelRoutes = createAudioChannelRoutes(audioChannel);
  return (request, url, server) => {
    if (url.pathname === AUDIO_STREAM_ROUTE && request.method === "GET") return serveStream(request, url);
    return channelRoutes(request, url, server);
  };
}
