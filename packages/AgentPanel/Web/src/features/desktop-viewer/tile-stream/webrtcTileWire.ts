// The two HTTP calls a tile stream makes besides its offer, and the answer it reads back.
//
// Kept apart from the component because these are the wire, not the lifecycle: what the
// sidecar returns for an offer, what a viewer says when it leaves, and what one line of
// telemetry looks like.

import { desktopDisplayId } from "@agentdesk/agent-feed-wire";
import type { AgentHttpTransport } from "@/features/activity-feed/transport/AgentHttpTransport";
import type {
  DesktopControlInput,
  WebrtcTileAnswer,
  WebrtcTileSourceMetadata,
} from "@agentdesk/agent-feed-wire";

const MAX_SOURCE_EXTENT = 100_000;
export const CONTROL_CHANNEL_LABEL = "agentdesk-control-v2";
export const CONTROL_BUFFER_LIMIT = 64 * 1024;

export interface DesktopControlTransport {
  send(input: DesktopControlInput): DesktopControlSendResult;
  /** Terminal controls cannot sit behind an unbounded data-channel backlog. */
  abort?(): void;
}

export type DesktopControlSendResult = "sent" | "channel-closed" | "backpressured";

export interface TileTelemetryEvent {
  attempt: string;
  phase: string;
  detail?: string;
  elapsedMs?: number;
}

function validSourceMetadata(value: unknown): value is WebrtcTileSourceMetadata {
  if (typeof value !== "object" || value === null) return false;
  const source = value as Record<string, unknown>;
  const cursor = source.cursor;
  return typeof source.width === "number"
    && Number.isFinite(source.width)
    && source.width > 0
    && source.width <= MAX_SOURCE_EXTENT
    && typeof source.height === "number"
    && Number.isFinite(source.height)
    && source.height > 0
    && source.height <= MAX_SOURCE_EXTENT
    && (source.displayId === undefined || desktopDisplayId(source.displayId))
    && (source.desktopNavigationVersion === undefined
      || (Number.isSafeInteger(source.desktopNavigationVersion) && Number(source.desktopNavigationVersion) > 0))
    && (source.desktopControlVersion === undefined
      || (typeof source.desktopControlVersion === "number"
        && Number.isSafeInteger(source.desktopControlVersion)
        && source.desktopControlVersion > 0))
    && typeof cursor === "object"
    && cursor !== null
    && typeof (cursor as { x?: unknown }).x === "number"
    && Number.isFinite((cursor as { x: number }).x)
    && (cursor as { x: number }).x >= 0
    && (cursor as { x: number }).x < source.width
    && typeof (cursor as { y?: unknown }).y === "number"
    && Number.isFinite((cursor as { y: number }).y)
    && (cursor as { y: number }).y >= 0
    && (cursor as { y: number }).y < source.height;
}

export function parseWebrtcTileAnswer(body: string): WebrtcTileAnswer {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new Error("WebRTC answer was invalid");
  }
  if (typeof value !== "object" || value === null) {
    throw new Error("WebRTC answer was invalid");
  }
  const answer = value as Record<string, unknown>;
  if (
    answer.type !== "answer"
    || typeof answer.sdp !== "string"
    || answer.sdp.length === 0
    || (answer.codec !== "h264" && answer.codec !== "h265")
    || !validSourceMetadata(answer.source)
  ) throw new Error("WebRTC answer was invalid");
  const source = answer.source as unknown as Record<string, unknown>;
  return {
    type: "answer",
    sdp: answer.sdp,
    codec: answer.codec,
    source: {
      ...source,
      desktopControlVersion: typeof source.desktopControlVersion === "number"
        ? source.desktopControlVersion
        : 0,
    },
  } as WebrtcTileAnswer;
}

/**
 * Sends WebView-authored evidence through the same authenticated control path
 * as the rest of the panel. The page never receives the sidecar token.
 */
/**
 * Tells the sidecar a peer is gone. Closing an RTCPeerConnection sends nothing the sidecar can
 * see, so without this it keeps the capture running until ICE consent expires thirty seconds
 * later; with two captures on one display that is a second whole-display capture nobody watches.
 *
 * `keepalive` is what makes this work on the way out of a page. A reload -- an HMR one included --
 * destroys the document without running React cleanup, and cancels every request in flight, so an
 * ordinary fetch fired from `pagehide` would be dropped and the abandoned capture would live on
 * for the consent timeout while the reloaded page asked for one of its own.
 */
export function postWebrtcClose(attempt: string, httpTransport?: Pick<AgentHttpTransport, "request">) {
  const body = { attempt };
  const request = httpTransport
    ? httpTransport.request("POST", "/api/park/webrtc/sessions/close", { body })
    : fetch("/api/park/webrtc/sessions/close", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        keepalive: true,
      });
  void request.catch(() => {
    // Best effort; the sidecar's consent timeout is the fallback.
  });
}

export function postTileTelemetry(
  windowID: number | "display",
  event: TileTelemetryEvent,
  httpTransport?: Pick<AgentHttpTransport, "request">,
) {
  const request = httpTransport
    ? httpTransport.request(
        "POST",
        `/api/park/tile/${windowID}/webrtc/telemetry`,
        { body: event },
      )
    : fetch(`/api/park/tile/${windowID}/webrtc/telemetry`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(event),
      });
  void request.catch(() => {
    // Evidence is best effort. The gesture or connection state remains
    // authoritative when its diagnostic request cannot reach the Mac.
  });
}
