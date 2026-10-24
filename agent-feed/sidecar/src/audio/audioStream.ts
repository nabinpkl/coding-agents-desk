// The audio channel's stream: a bed of noise, and whatever agents say over it, for as long as
// somebody listens.
//
//   GET /api/audio/stream?listener=<id>&noise=<level>&color=<color>  -> audio/aac, paced in real time
//
// One long-lived stream rather than a clip per message: a phone starts playback only from a tap,
// and a clip that ends can let iOS close the audio session, after which the next one does not start
// on a locked screen. So this never ends on its own; the listener ends it.
//
// The bed is the device's own noise (`POST /api/audio/noise` changes it, read here every tick), 0
// being silence. A message (`POST /api/audio/speak`) is mixed into that noise where it will play
// and spliced in, so the noise runs on under the voice with no seam (`noiseBed.ts`).
//
// Paced rather than sent as fast as it is read, so what the phone plays is what was said a moment
// ago, not something it buffered minutes earlier. Silence is sent as real frames, not nothing: a
// stream that sends nothing is one a player gives up on.

import { AUDIO_STREAM_ROUTE, type AudioNoiseColor } from "@agentdesk/agent-feed-wire";
import type { AdtsFrame } from "@/audio/adtsFrames";
import {
  audioChannel,
  createAudioChannelRoutes,
  DEFAULT_NOISE,
  isNoiseColor,
  type AudioChannel,
  type DeviceNoise,
} from "@/audio/audioChannel";
import { noiseBed, spliceMessage, type NoiseBed } from "@/audio/noiseBed";
import { clampNoiseLevel } from "@/audio/pcmAudio";
import { encodeAdtsFrames } from "@/audio/speechAudio";
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

/**
 * How far past the next frame to send a message is spliced in, about 0.7s: room for mixing and
 * encoding it (a few hundred milliseconds) before the stream reaches it. If it is not ready by
 * then the stream waits for it, which the lead covers.
 */
const SPLICE_AHEAD_FRAMES = 16;

/** A device id as the panel makes one (a UUID), or anything as plain. */
const LISTENER_ID = /^[A-Za-z0-9-]{1,64}$/;

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

type Splice = { atFrame: number; frames: Promise<AdtsFrame[]> };

/**
 * The device's noise, with each message spliced in.
 *
 * `clockMs` is the stream position of the next frame to send; a frame goes out once the wall clock,
 * plus the lead, reaches it. `bedFrame` counts frames along the bed as it repeats, so a message can
 * be mixed with exactly the noise it replaces, and the bed picks up after it where it would have
 * been.
 */
function pacedStream(listener: string, noise: DeviceNoise, label: string, stopped: AbortSignal, channel: AudioChannel) {
  let connectedAt = 0;
  let clockMs = 0;
  let bedFrame = 0;
  let spoken = 0;
  // Messages waiting their turn, oldest first, and the one being mixed in.
  const waiting: Int16Array[] = [];
  let splice: Splice | null = null;
  const unlisten = channel.listen(listener, noise, (speech) => waiting.push(speech));
  let finished = false;
  const finish = (how: string) => {
    if (finished) return;
    finished = true;
    unlisten();
    console.log(`[audio] ${label}: ${how} after ${seconds(Date.now() - connectedAt)}, ${spoken} message(s) played`);
  };

  const startSplice = (bed: NoiseBed) => {
    if (splice) return;
    const speech = waiting.shift();
    if (!speech) return;
    const atFrame = bedFrame + SPLICE_AHEAD_FRAMES;
    const frames = spliceMessage(bed, atFrame, speech, encodeAdtsFrames);
    // Handled here as well as where it is spliced, so a failure while it waits, or for a listener
    // who has left, is not an unhandled rejection, which takes the whole sidecar down.
    frames.catch(() => {});
    splice = { atFrame, frames };
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
      // Read each tick, so noise the device changes is heard from the next frames sent.
      const { level, color } = channel.noise(listener);
      const bed = await noiseBed(color, level);
      if (finished) return;
      const chunk: Uint8Array[] = [];
      const append = (frame: AdtsFrame) => {
        chunk.push(frame.bytes);
        clockMs += frame.durationMs;
      };
      while (clockMs <= dueMs) {
        startSplice(bed);
        if (splice && splice.atFrame === bedFrame) {
          const frames = await splice.frames;
          frames.forEach(append);
          bedFrame += frames.length;
          splice = null;
          spoken += 1;
          continue;
        }
        const frame = bed.frames[bedFrame % bed.frames.length];
        if (!frame) throw new Error("a noise bed with no frames");
        append(frame);
        bedFrame += 1;
      }
      if (finished) return;
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
  const level = Number(url.searchParams.get("noise") ?? DEFAULT_NOISE.level);
  if (!Number.isFinite(level)) return errorResponse("invalid_noise", "noise must be a level number", 400);
  const colorParam = url.searchParams.get("color") ?? DEFAULT_NOISE.color;
  if (!isNoiseColor(colorParam)) return errorResponse("invalid_noise", `no noise color "${colorParam}"`, 400);
  const color: AudioNoiseColor = colorParam;
  try {
    // Made before answering, so a broken encoder is a 500 rather than a stream that fails at once.
    await noiseBed(color, clampNoiseLevel(level));
  } catch (error) {
    return errorResponse("speech_failed", error instanceof Error ? error.message : String(error), 500);
  }
  // Which reader this is, for the log: a phone opens the same stream more than once while it probes.
  const range = request.headers.get("range") ?? "no range";
  const label = `stream ${listener.slice(0, 8)} ${color} ${clampNoiseLevel(level)} ${range} ${request.headers.get("user-agent")?.slice(0, 60) ?? ""}`;
  const noise: DeviceNoise = { level: clampNoiseLevel(level), color };
  return new Response(pacedStream(listener, noise, label, request.signal, audioChannel), {
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
