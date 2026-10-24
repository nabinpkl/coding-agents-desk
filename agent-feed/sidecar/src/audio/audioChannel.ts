// The audio channel's message side: text an agent forwards, spoken once and handed to every stream
// open now.
//
//   GET  /api/audio/listeners  -> { listeners }
//   POST /api/audio/speak      <- { text }  -> { listeners, durationMs }, or 409 nobody_listening
//
// A stream plays a message at its next gap (`audioTestStream.ts`). One synthesis for any number of
// listeners, and none for none: a message only goes out while a stream is open, and an agent is
// told plainly when nobody is, rather than having its words said to no one.

import {
  AUDIO_LISTENERS_ROUTE,
  AUDIO_SPEAK_MAX_CHARS,
  AUDIO_SPEAK_ROUTE,
  type AudioListenersResponse,
  type AudioSpeakResponse,
} from "@agentdesk/agent-feed-wire";
import { splitAdtsFrames, type AdtsFrame } from "@/audio/adtsFrames";
import { speakToAdts } from "@/audio/speechAudio";
import { errorResponse, jsonResponse } from "@/http/protocol/httpResponses";
import type { RouteHandler } from "@/http/protocol/route";

/** A stream's inbox: called with a message's frames, in the order messages were spoken. */
export type ChannelListener = (frames: AdtsFrame[]) => void;

/**
 * Text as `say` should read it. `say` obeys commands written `[[...]]` inside the text (volume,
 * rate, voice, silence), and an agent's message is not ours to let steer the voice, so every bracket
 * becomes a space, which `say` reads as nothing. Whitespace runs collapse so a pasted block
 * reads as sentences.
 */
export function speakableText(text: string): string {
  return text.replace(/[[\]]/g, " ").replace(/\s+/g, " ").trim();
}

export function createAudioChannel(speak: (text: string) => Promise<Uint8Array> = speakToAdts) {
  const listeners = new Set<ChannelListener>();
  return {
    /** Adds a stream's inbox; the returned function removes it. */
    listen(listener: ChannelListener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** How many streams are open now. */
    listening(): number {
      return listeners.size;
    },
    /** Speaks `text` and hands it to every stream open when it is ready; none open, none spoken. */
    async say(text: string): Promise<AudioSpeakResponse> {
      if (listeners.size === 0) return { listeners: 0, durationMs: 0 };
      const frames = splitAdtsFrames(await speak(speakableText(text)));
      // Counted after speaking: a stream that closed meanwhile was not reached.
      const reached = [...listeners];
      for (const listener of reached) listener(frames);
      return { listeners: reached.length, durationMs: Math.round(frames.reduce((sum, f) => sum + f.durationMs, 0)) };
    },
  };
}

export type AudioChannel = ReturnType<typeof createAudioChannel>;

/** The sidecar's one channel, which every stream and the speak route share. */
export const audioChannel = createAudioChannel();

async function speakRoute(request: Request, channel: AudioChannel): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("invalid_message", "body is not JSON", 400);
  }
  const text = typeof body === "object" && body !== null && "text" in body ? body.text : undefined;
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

export function createAudioSpeakRoute(channel: AudioChannel = audioChannel): RouteHandler {
  return (request, url) => {
    if (url.pathname === AUDIO_SPEAK_ROUTE && request.method === "POST") return speakRoute(request, channel);
    if (url.pathname === AUDIO_LISTENERS_ROUTE && request.method === "GET") {
      return jsonResponse({ listeners: channel.listening() } satisfies AudioListenersResponse);
    }
    return undefined;
  };
}
