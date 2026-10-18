// Which observed flows are Anthropic message streams, and what one holds while its
// session id is still being fetched.
//
// A flow is announced by the observer before its request body can be read, and the
// `session_id` that keys the mirror lives in that body. So deltas can arrive with
// nowhere to put them yet; a flow buffers them, bounded, until the bind lands.

import type { AgentSessionCapabilities } from "@/agents/agentBackend";
import type { ObserverCaptureHealth, ObserverEvent } from "@/live/claudeNetworkSource";
import type { LiveMessage } from "@/live/claudeLiveMessages";

/** A live Claude session can be read and streamed, and nothing else: the harness owns it. */
export const CLAUDE_LIVE_CAPABILITIES: AgentSessionCapabilities = {
  modes: ["nice"],
  canSend: false,
  canSteer: false,
  canAbort: false,
  canFetchRaw: false,
  canOpenTerminal: false,
  supportsExtensionUi: false,
  canStreamLive: true,
};

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
  /** The capture that recorded the flow, null when its announcement never said. */
  sourceId: string | null;
}

export function newFlowContext(sessionId: string | null = null): FlowContext {
  return {
    sessionId,
    message: null,
    pending: [],
    pendingBytes: 0,
    lost: 0,
    binding: false,
    ended: false,
    sourceId: null,
  };
}

/** The lifecycles in which a capture is still recording what it started. */
const CAPTURE_ALIVE = new Set(["CAPTURE_LIFECYCLE_STARTING", "CAPTURE_LIFECYCLE_RUNNING"]);

/**
 * The open flows a capture change has orphaned, and a line saying so when any of them was mid-reply;
 * null when it orphaned none.
 *
 * Most orphans are nothing: the flows a fresh subscription replays are finished, and are only still
 * held because nothing ends them. They are ended all the same, but only a reply cut off mid-stream
 * is worth a line, so the log does not cry wolf on every capture restart.
 *
 * proxy-agent records a flow under the capture that saw it start, and when that capture dies it
 * neither ends the flow nor carries it over: the flow stays active for good, its remaining deltas
 * never arrive, and its message would stream forever. Measured 2026-10-14: the capture exited 15s
 * into a turn, the mirror held only the turn's thinking, and the message read as streaming while
 * the session's own terminal sat on the question the rest of that turn had asked.
 *
 * Two readings say a flow's capture is gone, because one capture runs at a time: that capture
 * reported itself stopped or failed, or a different one reported itself running.
 */
export function flowsLostWithCapture(
  contexts: ReadonlyMap<string, FlowContext>,
  health: ObserverCaptureHealth,
): { flowIds: string[]; line: string | null } | null {
  const source = health.sourceId;
  if (typeof source !== "string" || !source) return null;
  const alive = typeof health.lifecycle === "string" && CAPTURE_ALIVE.has(health.lifecycle);
  const flowIds: string[] = [];
  for (const [flowId, context] of contexts) {
    if (context.sourceId === null) continue;
    if (alive ? context.sourceId !== source : context.sourceId === source) flowIds.push(flowId);
  }
  if (flowIds.length === 0) return null;
  const cut = flowIds.filter((flowId) => contexts.get(flowId)!.message?.phase === "streaming").length;
  return {
    flowIds,
    line:
      cut === 0
        ? null
        : `agent-feed-claude-live-capture-lost: replies=${cut}` +
          ` capture=${source} lifecycle=${String(health.lifecycle ?? "?")}` +
          (health.failureCategory ? ` failure=${String(health.failureCategory)}` : ""),
  };
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

/**
 * When the API began this flow, falling back to the given moment.
 *
 * `observedAt` is the right clock for a DELTA -- it is stamped as the delta streams, and measured
 * 2026-09-16 across 1053 events it sat a median of 0ms and at most 3ms behind arrival. It is the
 * wrong clock for anything derived from the flow itself, because the observer RESTAMPS it on the
 * flows it replays when a stream is created: measured the same day, all 18 flows in an opening
 * burst carried the stream's own open time while their own starts spanned the previous three
 * hours, one of them having completed 178 seconds before the subscription existed.
 *
 * `usage/claudeLiveQuota.ts` parses the same field for the same reason and does not share this,
 * because importing it there would close a cycle: `claudeNetworkSource` imports the quota module,
 * and this module imports `claudeNetworkSource`.
 */
export function flowStartedAtMs(flow: { startedAt?: unknown }, fallbackMs: number): number {
  const parsed = typeof flow.startedAt === "string" ? Date.parse(flow.startedAt) : NaN;
  return Number.isFinite(parsed) ? parsed : fallbackMs;
}
