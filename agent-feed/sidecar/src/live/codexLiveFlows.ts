// Which observed flows are codex response sockets, and what one tracks while it is open.
//
// Unlike the claude mirror, binding is synchronous: the session id rides in the
// flow's request headers, so a flow never has to buffer messages waiting for it. What
// a flow does have to hold is which item rows are mid-stream, so an abruptly closed
// socket can complete them rather than leaving rows stuck at "streaming".

import { CODECX_RESPONSES_AUTHORITY, CODECX_RESPONSES_PATH } from "@/live/codexNetworkSource";
import type { ObserverEvent } from "@/live/claudeNetworkSource";

export interface FlowContext {
  sessionId: string;
  /** Item ids still streaming on this flow, so an abrupt socket end can complete them. */
  streaming: Set<string>;
  ended: boolean;
}

export function isCodexStream(flow: { authority?: unknown; path?: unknown; protocol?: unknown }): boolean {
  if (flow.protocol !== "OBSERVED_PROTOCOL_WEBSOCKET") return false;
  if (typeof flow.authority !== "string" || flow.authority !== CODECX_RESPONSES_AUTHORITY) {
    return false;
  }
  return flow.path === CODECX_RESPONSES_PATH;
}

export function observedAtMs(event: ObserverEvent): number {
  const value = event.observedAt;
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : Date.now();
}
