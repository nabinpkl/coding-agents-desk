import { INTERACTION_HANDLER, postToHost } from "@/lib/host-bridge";

export interface NativeVoiceEnvelope {
  t: string;
  rid?: string;
  sid?: string;
  j?: string;
  z?: string;
  c?: string;
  m?: string;
  r?: {
    requestID: string;
    status: number;
    contentType?: string;
    sequence: number;
    isFinal: boolean;
    body: string;
  };
}

const handlers = new Set<(message: NativeVoiceEnvelope) => void>();
let installed = false;

export function subscribeNativeVoice(
  handler: (message: NativeVoiceEnvelope) => void,
): () => void {
  if (!installed && typeof window !== "undefined") {
    installed = true;
    window.__interactionDeliver = (delivery: unknown) => {
      const value = delivery as { type?: string; payload?: NativeVoiceEnvelope };
      if (value?.type !== "voiceLane" || !value.payload) return;
      for (const subscriber of handlers) subscriber(value.payload);
    };
  }
  handlers.add(handler);
  return () => handlers.delete(handler);
}

export function postNativeVoice(body: Record<string, unknown>): void {
  postToHost(INTERACTION_HANDLER, body);
}

declare global {
  interface Window {
    __interactionDeliver?: (payload: unknown) => void;
  }
}
