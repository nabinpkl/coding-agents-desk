import { INTERACTION_HANDLER, postToHost } from "@/lib/host-bridge";
import { subscribeInteractionDelivery } from "@/lib/interaction-delivery";

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

export function subscribeNativeVoice(
  handler: (message: NativeVoiceEnvelope) => void,
): () => void {
  return subscribeInteractionDelivery("voiceLane", handler);
}

export function postNativeVoice(body: Record<string, unknown>): void {
  postToHost(INTERACTION_HANDLER, body);
}
