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

/**
 * How much of a response one unbound flow may hold while its body is fetched.
 *
 * This is a MEMORY guard and nothing else, which is what the count it replaces was not: the buffer
 * used to stop at 200 deltas, about 15KB, and a stream that reached the cap before its bind landed
 * had its whole flow thrown away -- no session id, no tool results, no message. A turn that was
 * merely fast therefore went unmirrored, and nothing said so. Four megabytes is several times the
 * largest answer the API can produce, so a real turn cannot reach it and the bound still holds when
 * a body fetch never comes back.
 */
export const MAX_PENDING_BYTES_PER_FLOW = 4 * 1024 * 1024;

export interface FlowContext {
  sessionId: string | null;
  message: LiveMessage | null;
  pending: Array<{ payload: string; ts: number }>;
  /** What `pending` costs, against `MAX_PENDING_BYTES_PER_FLOW`. */
  pendingBytes: number;
  /** Deltas the buffer had no room for. Nonzero means this message will have a hole in it. */
  lost: number;
  /** True while a body fetch is in flight, which is the only thing that can bind this flow. */
  binding: boolean;
  /** True once the observer reported stream end while the body bind was still in flight. */
  ended: boolean;
}

export function newFlowContext(sessionId: string | null = null): FlowContext {
  return { sessionId, message: null, pending: [], pendingBytes: 0, lost: 0, binding: false, ended: false };
}

/** Holds one delta until the bind lands, or counts it lost when the flow has buffered its fill. */
export function bufferDelta(context: FlowContext, payload: string, ts: number): void {
  if (context.pendingBytes + payload.length > MAX_PENDING_BYTES_PER_FLOW) {
    context.lost += 1;
    return;
  }
  context.pending.push({ payload, ts });
  context.pendingBytes += payload.length;
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
