// The audio channel's message side: text an agent forwards, spoken once and handed to every stream
// open now, and how each listening device hears it.
//
//   GET  /api/audio/listeners  -> { listeners }
//   POST /api/audio/speak      <- { text }  -> { listeners, durationMs }, or 409 nobody_listening
//   POST /api/audio/mix        <- { listener, noise?, color?, voice? }  -> 204, or 404 when it is not listening
//
// A message is spoken once, to samples, and handed to every stream, which mixes it into its own
// noise where it will play, at its own voice level (`audioStream.ts`, `noiseBed.ts`). None of it happens for nobody: a
// message only goes out while a stream is open, and an agent is told plainly when nobody is, rather
// than having its words said to no one.

import {
  AUDIO_LISTENERS_ROUTE,
  AUDIO_MIX_ROUTE,
  AUDIO_NOISE_COLORS,
  AUDIO_SPEAK_MAX_CHARS,
  AUDIO_SPEAK_ROUTE,
  type AudioListenersResponse,
  type AudioMix,
  type AudioNoiseColor,
  type AudioSpeakResponse,
} from "@agentdesk/agent-feed-wire";
import { clampLevel, SAMPLE_RATE } from "@/audio/pcmAudio";
import { speakToSamples } from "@/audio/speechAudio";
import { errorResponse, jsonResponse } from "@/http/protocol/httpResponses";
import type { RouteHandler } from "@/http/protocol/route";

/** A stream's inbox: called with a message's spoken samples, in the order messages were spoken. */
export type ChannelInbox = (speech: Int16Array) => void;

/** Speaking, injected so a test does not run `say`. */
export type ChannelSpeak = (text: string) => Promise<Int16Array>;

/** The mix a device gets until it says otherwise: no noise, and the voice about as spoken. */
export const DEFAULT_MIX: AudioMix = { noise: 0, color: "pink", voice: 8 };

/** `mix` with its levels as whole steps in range. */
function clampMix(mix: AudioMix): AudioMix {
  return { noise: clampLevel(mix.noise), color: mix.color, voice: clampLevel(mix.voice) };
}

export function isNoiseColor(value: unknown): value is AudioNoiseColor {
  return AUDIO_NOISE_COLORS.some((color) => color === value);
}

/**
 * One listening device: its mix, and its open streams. Usually one stream; a phone opens a
 * second while it probes, and both get every message, but the device counts once.
 */
type Device = { mix: AudioMix; inboxes: Set<ChannelInbox> };

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
    /** Adds one of `listener`'s streams with `mix`; the returned function removes it. */
    listen(listener: string, mix: AudioMix, inbox: ChannelInbox): () => void {
      let device = devices.get(listener);
      if (!device) {
        device = { mix: DEFAULT_MIX, inboxes: new Set() };
        devices.set(listener, device);
      }
      // The newest connection's word on it: a resume carries the mix the device has now.
      device.mix = clampMix(mix);
      device.inboxes.add(inbox);
      const joined = device;
      return () => {
        joined.inboxes.delete(inbox);
        if (joined.inboxes.size === 0 && devices.get(listener) === joined) devices.delete(listener);
      };
    },
    /** `listener`'s mix; the default once it has no stream open. */
    mix(listener: string): AudioMix {
      return devices.get(listener)?.mix ?? DEFAULT_MIX;
    },
    /** Changes any part of `listener`'s mix; false when it has no stream open. */
    setMix(listener: string, change: Partial<AudioMix>): boolean {
      const device = devices.get(listener);
      if (!device) return false;
      device.mix = clampMix({
        noise: change.noise ?? device.mix.noise,
        color: change.color ?? device.mix.color,
        voice: change.voice ?? device.mix.voice,
      });
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

/** A level from a request body: absent, or a finite number; anything else is refused. */
function optionalLevel(value: unknown): number | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

async function mixRoute(request: Request, channel: AudioChannel): Promise<Response> {
  const body = await readJson(request);
  const listener = body?.listener;
  const noise = optionalLevel(body?.noise);
  const voice = optionalLevel(body?.voice);
  const color = body?.color;
  const colorValid = color === undefined || isNoiseColor(color);
  const nothing = noise === undefined && voice === undefined && color === undefined;
  if (typeof listener !== "string" || noise === null || voice === null || !colorValid || nothing) {
    return errorResponse(
      "invalid_mix",
      `expected { listener, noise?, color?, voice? } with color one of ${AUDIO_NOISE_COLORS.join(", ")}`,
      400,
    );
  }
  if (!channel.setMix(listener, { noise, voice, color })) {
    return errorResponse("not_listening", "that device has no audio stream open", 404);
  }
  return new Response(null, { status: 204 });
}

export function createAudioChannelRoutes(channel: AudioChannel = audioChannel): RouteHandler {
  return (request, url) => {
    if (url.pathname === AUDIO_SPEAK_ROUTE && request.method === "POST") return speakRoute(request, channel);
    if (url.pathname === AUDIO_MIX_ROUTE && request.method === "POST") return mixRoute(request, channel);
    if (url.pathname === AUDIO_LISTENERS_ROUTE && request.method === "GET") {
      return jsonResponse({ listeners: channel.listening() } satisfies AudioListenersResponse);
    }
    return undefined;
  };
}
