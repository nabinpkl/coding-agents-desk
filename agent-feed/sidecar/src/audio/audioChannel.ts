// The audio channel's message side: text an agent forwards, spoken once and handed to every stream
// open now, and each listening device's noise level.
//
//   GET  /api/audio/listeners  -> { listeners }
//   POST /api/audio/speak      <- { text }  -> { listeners, durationMs }, or 409 nobody_listening
//   POST /api/audio/noise      <- { listener, level }  -> 204, or 404 when that device is not listening
//
// A stream plays a message at its next gap (`audioStream.ts`). A message is spoken once and mixed
// once for each noise level in use, so the noise runs on under the voice at the level each device
// chose. None of it happens for nobody: a message only goes out while a stream is open, and an
// agent is told plainly when nobody is, rather than having its words said to no one.

import {
  AUDIO_LISTENERS_ROUTE,
  AUDIO_NOISE_ROUTE,
  AUDIO_SPEAK_MAX_CHARS,
  AUDIO_SPEAK_ROUTE,
  type AudioListenersResponse,
  type AudioSpeakResponse,
} from "@agentdesk/agent-feed-wire";
import type { AdtsFrame } from "@/audio/adtsFrames";
import { clampNoiseLevel, withNoise } from "@/audio/pcmAudio";
import { encodeToAdts, speakToSamples } from "@/audio/speechAudio";
import { errorResponse, jsonResponse } from "@/http/protocol/httpResponses";
import type { RouteHandler } from "@/http/protocol/route";

/** A stream's inbox: called with a message's frames, in the order messages were spoken. */
export type ChannelInbox = (frames: AdtsFrame[]) => void;

/** Speaking and encoding, injected so a test runs neither `say` nor `afconvert`. */
export type ChannelSpeech = {
  speak: (text: string) => Promise<Int16Array>;
  encode: (samples: Int16Array) => Promise<AdtsFrame[]>;
};

const LIVE_SPEECH: ChannelSpeech = { speak: speakToSamples, encode: encodeToAdts };

/**
 * One listening device: its noise level, and its open streams. Usually one stream; a phone opens a
 * second while it probes, and both get every message, but the device counts once.
 */
type Device = { level: number; inboxes: Set<ChannelInbox> };

/**
 * Text as `say` should read it. `say` obeys commands written `[[...]]` inside the text (volume,
 * rate, voice, silence), and an agent's message is not ours to let steer the voice, so every bracket
 * becomes a space, which `say` reads as nothing. Whitespace runs collapse so a pasted block
 * reads as sentences.
 */
export function speakableText(text: string): string {
  return text.replace(/[[\]]/g, " ").replace(/\s+/g, " ").trim();
}

function nearest(levels: number[], level: number): number {
  return levels.reduce((best, each) => (Math.abs(each - level) < Math.abs(best - level) ? each : best));
}

export function createAudioChannel(speech: ChannelSpeech = LIVE_SPEECH, random: () => number = Math.random) {
  const devices = new Map<string, Device>();
  return {
    /** Adds one of `listener`'s streams at `level`; the returned function removes it. */
    listen(listener: string, level: number, inbox: ChannelInbox): () => void {
      let device = devices.get(listener);
      if (!device) {
        device = { level: 0, inboxes: new Set() };
        devices.set(listener, device);
      }
      // The newest connection's word on it: a resume carries the level the device has now.
      device.level = clampNoiseLevel(level);
      device.inboxes.add(inbox);
      const joined = device;
      return () => {
        joined.inboxes.delete(inbox);
        if (joined.inboxes.size === 0 && devices.get(listener) === joined) devices.delete(listener);
      };
    },
    /** `listener`'s noise level, 0 once it has no stream open. */
    level(listener: string): number {
      return devices.get(listener)?.level ?? 0;
    },
    /** Sets `listener`'s noise level; false when it has no stream open. */
    setLevel(listener: string, level: number): boolean {
      const device = devices.get(listener);
      if (!device) return false;
      device.level = clampNoiseLevel(level);
      return true;
    },
    /** How many devices are listening now. */
    listening(): number {
      return devices.size;
    },
    /** Speaks `text` and hands it to every stream open when it is ready; none open, none spoken. */
    async say(text: string): Promise<AudioSpeakResponse> {
      if (devices.size === 0) return { listeners: 0, durationMs: 0 };
      const samples = await speech.speak(speakableText(text));
      const levels = [...new Set([...devices.values()].map((device) => device.level))];
      const mixed = new Map(
        await Promise.all(
          levels.map(async (level) => [level, await speech.encode(withNoise(samples, level, random))] as const),
        ),
      );
      // Delivered to who is listening now: a device that left meanwhile was not reached, and one
      // that joined or changed level meanwhile hears the nearest level that was made.
      let durationMs = 0;
      for (const device of devices.values()) {
        const frames = mixed.get(nearest(levels, device.level)) ?? [];
        durationMs = frames.reduce((sum, frame) => sum + frame.durationMs, 0);
        for (const inbox of device.inboxes) inbox(frames);
      }
      return { listeners: devices.size, durationMs: Math.round(durationMs) };
    },
  };
}

export type AudioChannel = ReturnType<typeof createAudioChannel>;

/** The sidecar's one channel, which every stream and the routes share. */
export const audioChannel = createAudioChannel();

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json();
    return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function speakRoute(request: Request, channel: AudioChannel): Promise<Response> {
  const body = await readJson(request);
  if (!body) return errorResponse("invalid_message", "body is not a JSON object", 400);
  const text = body.text;
  if (typeof text !== "string" || speakableText(text) === "") {
    return errorResponse("invalid_message", "expected { text } with something to say", 400);
  }
  if (text.length > AUDIO_SPEAK_MAX_CHARS) {
    return errorResponse("message_too_long", `text is over ${AUDIO_SPEAK_MAX_CHARS} characters`, 413);
  }
  let answer: AudioSpeakResponse;
  try {
    answer = await channel.say(text);
  } catch (error) {
    return errorResponse("speech_failed", error instanceof Error ? error.message : String(error), 500);
  }
  // Also when the last stream closed while the message was being spoken: nobody heard it.
  if (answer.listeners === 0) {
    return errorResponse("nobody_listening", "no audio stream is open, so nothing was said", 409);
  }
  console.log(`[audio] spoke ${JSON.stringify(text.slice(0, 60))} to ${answer.listeners} listener(s)`);
  return jsonResponse(answer);
}

async function noiseRoute(request: Request, channel: AudioChannel): Promise<Response> {
  const body = await readJson(request);
  const listener = body?.listener;
  const level = body?.level;
  if (typeof listener !== "string" || typeof level !== "number" || !Number.isFinite(level)) {
    return errorResponse("invalid_noise", "expected { listener, level }", 400);
  }
  if (!channel.setLevel(listener, level)) {
    return errorResponse("not_listening", "that device has no audio stream open", 404);
  }
  return new Response(null, { status: 204 });
}

export function createAudioChannelRoutes(channel: AudioChannel = audioChannel): RouteHandler {
  return (request, url) => {
    if (url.pathname === AUDIO_SPEAK_ROUTE && request.method === "POST") return speakRoute(request, channel);
    if (url.pathname === AUDIO_NOISE_ROUTE && request.method === "POST") return noiseRoute(request, channel);
    if (url.pathname === AUDIO_LISTENERS_ROUTE && request.method === "GET") {
      return jsonResponse({ listeners: channel.listening() } satisfies AudioListenersResponse);
    }
    return undefined;
  };
}
