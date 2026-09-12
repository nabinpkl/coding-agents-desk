// What the receiver's own statistics say about whether video is still arriving.
//
// The shapes the browsers actually publish, the delta between two samples, and the one
// word that describes it. Separate from the stream because it is arithmetic over numbers
// a peer hands out, with nothing to do with how the peer was built.

// occur between ticks; the sidecar coalesces them onto the same one-second timeline.
export const RECEIVER_STATS_INTERVAL_MS = 1_000;
const VIDEO_PRESENTATION_INTERVAL_MS = 5_000;
const PRESENTATION_WATCHDOG_INTERVAL_MS = 250;
const PRESENTATION_GAP_THRESHOLD_MS = 750;
const PRESENTATION_GAP_REPORT_INTERVAL_MS = 1_000;
// Fast Refresh preserves mounted effects when their dependency values do not

export type ReceiverVideoStats = RTCInboundRtpStreamStats & {
  bytesReceived?: number;
  freezeCount?: number;
  totalFreezesDuration?: number;
  framesPerSecond?: number;
  keyFramesDecoded?: number;
  mediaType?: string;
  packetsRepaired?: number;
  powerEfficientDecoder?: boolean;
};

export type CandidateStats = RTCStats & {
  candidateType?: string;
  networkType?: string;
  protocol?: string;
  relayProtocol?: string;
  tcpType?: string;
};

export type CandidatePairStats = RTCIceCandidatePairStats & {
  bytesReceived?: number;
  bytesSent?: number;
  nominated?: boolean;
  state?: string;
};

export interface ReceiverProgressSample {
  atMs: number;
  bytesReceived: number;
  packetsReceived: number;
  framesReceived: number;
  framesDecoded: number;
  framesDropped: number;
  presentedSamples: number;
  connectionState: RTCPeerConnectionState;
  visibilityState: DocumentVisibilityState;
}

export function receiverProgressDelta(
  previous: ReceiverProgressSample | null,
  current: ReceiverProgressSample,
) {
  if (!previous) return null;
  return {
    intervalMs: Math.max(0, Math.round(current.atMs - previous.atMs)),
    bytes: current.bytesReceived - previous.bytesReceived,
    packets: current.packetsReceived - previous.packetsReceived,
    received: current.framesReceived - previous.framesReceived,
    decoded: current.framesDecoded - previous.framesDecoded,
    dropped: current.framesDropped - previous.framesDropped,
    presented: current.presentedSamples - previous.presentedSamples,
  };
}

/**
 * Classifies the first pipeline boundary that stopped moving. This is deliberately
 * counter-based: a static desktop still produces access units, so decoded frames without
 * compositor callbacks is our/WebKit presentation trouble, while no inbound bytes after
 * the Mac reports sends is genuine path silence.
 */
export function classifyReceiverProgress(
  previous: ReceiverProgressSample | null,
  current: ReceiverProgressSample,
): string {
  if (current.visibilityState !== "visible") return "page-hidden";
  if (
    current.connectionState === "disconnected"
    || current.connectionState === "failed"
    || current.connectionState === "closed"
  ) return "transport-disconnected";
  const delta = receiverProgressDelta(previous, current);
  if (!delta) return "baseline";
  if (delta.bytes <= 0 && delta.packets <= 0) return "source-or-network-silent";
  if (delta.received <= 0) return "rtp-frame-assembly-stalled";
  if (delta.decoded <= 0) return "decoder-stalled";
  if (delta.presented <= 0) return "presentation-stalled";
  return "progressing";
}
