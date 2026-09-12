// Which observed flows are Anthropic message streams, and what one holds while its
// session id is still being fetched.
//
// A flow is announced by the observer before its request body can be read, and the
// `session_id` that keys the mirror lives in that body. So deltas can arrive with
// nowhere to put them yet; a flow buffers them, bounded, until the bind lands.

import type { ObserverEvent } from "@/live/claudeNetworkSource";
import type { LiveMessage } from "@/live/claudeLiveMessages";

const MESSAGE_STREAM_AUTHORITIES = new Set(["api.anthropic.com", "a-api.anthropic.com"]);
const MESSAGE_STREAM_PATH = "/v1/messages";
export const MAX_PENDING_PER_FLOW = 200;

export interface FlowContext {
  sessionId: string | null;
  message: LiveMessage | null;
  pending: Array<{ payload: string; ts: number }>;
  /** True once the observer reported stream end while the body bind was still in flight. */
  ended: boolean;
}

export function isMessageStream(flow: { authority?: unknown; path?: unknown; protocol?: unknown }): boolean {
  if (flow.protocol !== "OBSERVED_PROTOCOL_SSE") return false;
  if (typeof flow.authority !== "string" || !MESSAGE_STREAM_AUTHORITIES.has(flow.authority)) {
    return false;
  }
  return flow.path === MESSAGE_STREAM_PATH;
}

export function observedAtMs(event: ObserverEvent): number {
  const value = event.observedAt;
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : Date.now();
}
