// The audio channel's message side: text an agent forwards, spoken once and handed to every stream
// open now, and each listening device's noise.
//
//   GET  /api/audio/listeners  -> { listeners }
//   POST /api/audio/speak      <- { text }  -> { listeners, durationMs }, or 409 nobody_listening
//   POST /api/audio/noise      <- { listener, level?, color? }  -> 204, or 404 when it is not listening
//
// A message is spoken once, to samples, and handed to every stream, which mixes it into its own
// noise where it will play (`audioStream.ts`, `noiseBed.ts`). None of it happens for nobody: a
// message only goes out while a stream is open, and an agent is told plainly when nobody is, rather
// than having its words said to no one.

import {
  AUDIO_LISTENERS_ROUTE,
  AUDIO_NOISE_COLORS,
  AUDIO_NOISE_ROUTE,
  AUDIO_SPEAK_MAX_CHARS,
  AUDIO_SPEAK_ROUTE,
  type AudioListenersResponse,
  type AudioNoiseColor,
  type AudioSpeakResponse,
} from "@agentdesk/agent-feed-wire";
import { clampNoiseLevel, SAMPLE_RATE } from "@/audio/pcmAudio";
import { speakToSamples } from "@/audio/speechAudio";
import { errorResponse, jsonResponse } from "@/http/protocol/httpResponses";
import type { RouteHandler } from "@/http/protocol/route";

/** A stream's inbox: called with a message's spoken samples, in the order messages were spoken. */
export type ChannelInbox = (speech: Int16Array) => void;

/** Speaking, injected so a test does not run `say`. */
export type ChannelSpeak = (text: string) => Promise<Int16Array>;

/** What a device hears under the voices. */
export type DeviceNoise = { level: number; color: AudioNoiseColor };

/** The noise a device gets until it says otherwise. */
export const DEFAULT_NOISE: DeviceNoise = { level: 0, color: "pink" };

export function isNoiseColor(value: unknown): value is AudioNoiseColor {
  return AUDIO_NOISE_COLORS.some((color) => color === value);
}

/**
 * One listening device: its noise, and its open streams. Usually one stream; a phone opens a
 * second while it probes, and both get every message, but the device counts once.
 */
type Device = { noise: DeviceNoise; inboxes: Set<ChannelInbox> };

/**
 * Text as `say` should read it. `say` obeys commands written `[[...]]` inside the text (volume,
 * rate, voice, silence), and an agent's message is not ours to let steer the voice, so every bracket
 * becomes a space, which `say` reads as nothing. Whitespace runs collapse so a pasted block
 * reads as sentences.
 */
export function speakableText(text: string): string {
  return text.replace(/[[\]]/g, " ").replace(/\s+/g, " ").trim();
}

export function createAudioChannel(speak: ChannelSpeak = speakToSamples) {
  const devices = new Map<string, Device>();
  return {
    /** Adds one of `listener`'s streams with `noise`; the returned function removes it. */
    listen(listener: string, noise: DeviceNoise, inbox: ChannelInbox): () => void {
      let device = devices.get(listener);
      if (!device) {
        device = { noise: DEFAULT_NOISE, inboxes: new Set() };
        devices.set(listener, device);
      }
      // The newest connection's word on it: a resume carries the noise the device has now.
      device.noise = { level: clampNoiseLevel(noise.level), color: noise.color };
      device.inboxes.add(inbox);
      const joined = device;
      return () => {
        joined.inboxes.delete(inbox);
        if (joined.inboxes.size === 0 && devices.get(listener) === joined) devices.delete(listener);
      };
    },
    /** `listener`'s noise; the default once it has no stream open. */
    noise(listener: string): DeviceNoise {
      return devices.get(listener)?.noise ?? DEFAULT_NOISE;
    },
    /** Changes `listener`'s noise level, color or both; false when it has no stream open. */
    setNoise(listener: string, change: Partial<DeviceNoise>): boolean {
      const device = devices.get(listener);
      if (!device) return false;
      device.noise = {
        level: change.level === undefined ? device.noise.level : clampNoiseLevel(change.level),
        color: change.color ?? device.noise.color,
      };
      return true;
    },
    /** How many devices are listening now. */
    listening(): number {
      return devices.size;
    },
    /** Speaks `text` and hands it to every stream open when it is ready; none open, none spoken. */
    async say(text: string): Promise<AudioSpeakResponse> {
      if (devices.size === 0) return { listeners: 0, durationMs: 0 };
      const speech = await speak(speakableText(text));
      // Delivered to who is listening now: a device that left meanwhile was not reached.
      for (const device of devices.values()) for (const inbox of device.inboxes) inbox(speech);
      return { listeners: devices.size, durationMs: Math.round((speech.length / SAMPLE_RATE) * 1000) };
    },
  };
}

export type AudioChannel = ReturnType<typeof createAudioChannel>;

/** The audio process's one channel, which every stream and the routes share. */
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
  const color = body?.color;
  const levelValid = level === undefined || (typeof level === "number" && Number.isFinite(level));
  const colorValid = color === undefined || isNoiseColor(color);
  if (typeof listener !== "string" || !levelValid || !colorValid || (level === undefined && color === undefined)) {
    return errorResponse(
      "invalid_noise",
      `expected { listener, level?, color? } with color one of ${AUDIO_NOISE_COLORS.join(", ")}`,
      400,
    );
  }
  if (!channel.setNoise(listener, { level, color })) {
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
