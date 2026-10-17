// What the viewer says about a connection, and what the sidecar knows about the same one.
//
// Two halves of one question, which is why they are one file: a browser reports what it received
// and the sidecar holds what it sent, and neither alone answers whether a stream is arriving.
// The correlation is deliberately labelled an estimate -- see `WebrtcDeliveryDiagnostics`.
//
// Bounded and pruned throughout: a failing phone must leave evidence without becoming a leak.

import type { RTCRtpHistoryRepairStats } from "werift";
import { jsonResponse } from "@/http/protocol/httpResponses";
import type { SharedEncoder } from "@/http/tile/tile-encoder/webrtcEncoderPool";
import { bounded } from "@/http/tile/tile-peer/webrtcTileOffer";

export interface TileTelemetry {
  attempt?: unknown;
  phase?: unknown;
  detail?: unknown;
  elapsedMs?: unknown;
}

export interface WebrtcDeliveryServerSample {
  sentRtpPackets: number;
  sentRtpBytes: number;
  retransmittedPacketsSent: number;
  retransmittedBytesSent: number;
  nackPacketsRequested: number;
  nackCacheHits: number;
  nackCacheMisses: number;
}

export interface WebrtcDeliveryClientSample {
  sample: number;
  elapsedMs: number;
  pair: string | null;
  pathState: string | null;
  rttMs: number | null;
  candidateBytesReceived: number;
  candidateBytesSent: number;
  inboundRtpPackets: number;
  inboundRtpBytes: number;
}

type DeliverySamplePair = {
  server: WebrtcDeliveryServerSample;
  client: WebrtcDeliveryClientSample;
};

const DELIVERY_CORRELATION_MIN_INTERVAL_MS = 900;

/**
 * Aligns browser receiver counters with the sender counters sampled when that
 * report reaches the sidecar. The backlog is deliberately labelled an estimate:
 * browser packetsReceived counts accepted media packets while sender repair
 * writes can duplicate a packet already received, so only sustained movement is
 * meaningful. Pair changes and counter resets start a new baseline.
 */
export class WebrtcDeliveryDiagnostics {
  private previous: DeliverySamplePair | null = null;
  private estimatedPendingMediaPackets = 0;

  sample(server: WebrtcDeliveryServerSample, client: WebrtcDeliveryClientSample) {
    const previous = this.previous;
    if (previous && client.sample <= previous.client.sample) return null;
    if (
      previous
      && client.elapsedMs - previous.client.elapsedMs < DELIVERY_CORRELATION_MIN_INTERVAL_MS
    ) return null;

    const pairChanged = previous !== null && client.pair !== previous.client.pair;
    const counterReset = previous !== null && !pairChanged && (
      server.sentRtpPackets < previous.server.sentRtpPackets
      || server.sentRtpBytes < previous.server.sentRtpBytes
      || server.retransmittedPacketsSent < previous.server.retransmittedPacketsSent
      || server.retransmittedBytesSent < previous.server.retransmittedBytesSent
      || server.nackPacketsRequested < previous.server.nackPacketsRequested
      || server.nackCacheHits < previous.server.nackCacheHits
      || server.nackCacheMisses < previous.server.nackCacheMisses
      || client.inboundRtpPackets < previous.client.inboundRtpPackets
      || client.inboundRtpBytes < previous.client.inboundRtpBytes
      || client.candidateBytesReceived < previous.client.candidateBytesReceived
      || client.candidateBytesSent < previous.client.candidateBytesSent
    );
    this.previous = { server, client };

    if (!previous || pairChanged || counterReset) {
      this.estimatedPendingMediaPackets = 0;
      return {
        event: "baseline",
        sample: client.sample,
        pair: client.pair,
        pairChanged,
        counterReset,
        path: {
          state: client.pathState,
          rttMs: client.rttMs,
          bytesReceived: client.candidateBytesReceived,
          bytesSent: client.candidateBytesSent,
        },
        sender: {
          mediaPackets: server.sentRtpPackets,
          mediaBytes: server.sentRtpBytes,
          repairPackets: server.retransmittedPacketsSent,
          repairBytes: server.retransmittedBytesSent,
        },
        receiver: {
          mediaPackets: client.inboundRtpPackets,
          mediaBytes: client.inboundRtpBytes,
        },
        backlog: { estimatedPendingMediaPackets: 0 },
      };
    }

    const senderMediaPackets = server.sentRtpPackets - previous.server.sentRtpPackets;
    const senderMediaBytes = server.sentRtpBytes - previous.server.sentRtpBytes;
    const senderRepairPackets = server.retransmittedPacketsSent
      - previous.server.retransmittedPacketsSent;
    const senderRepairBytes = server.retransmittedBytesSent
      - previous.server.retransmittedBytesSent;
    const receiverMediaPackets = client.inboundRtpPackets - previous.client.inboundRtpPackets;
    const receiverMediaBytes = client.inboundRtpBytes - previous.client.inboundRtpBytes;
    const backlogPacketDelta = senderMediaPackets - receiverMediaPackets;
    const recoveredPendingMediaPackets = Math.min(
      this.estimatedPendingMediaPackets,
      Math.max(0, -backlogPacketDelta),
    );
    this.estimatedPendingMediaPackets = Math.max(
      0,
      this.estimatedPendingMediaPackets + backlogPacketDelta,
    );

    return {
      event: "sample",
      sample: client.sample,
      intervalMs: client.elapsedMs - previous.client.elapsedMs,
      pair: client.pair,
      pairChanged: false,
      counterReset: false,
      path: {
        state: client.pathState,
        rttMs: client.rttMs,
        bytesReceivedDelta: client.candidateBytesReceived
          - previous.client.candidateBytesReceived,
        bytesSentDelta: client.candidateBytesSent - previous.client.candidateBytesSent,
      },
      sender: {
        mediaPacketsDelta: senderMediaPackets,
        mediaBytesDelta: senderMediaBytes,
        repairPacketsDelta: senderRepairPackets,
        repairBytesDelta: senderRepairBytes,
        transportWritePacketsDelta: senderMediaPackets + senderRepairPackets,
        transportWriteBytesDelta: senderMediaBytes + senderRepairBytes,
      },
      receiver: {
        mediaPacketsDelta: receiverMediaPackets,
        mediaBytesDelta: receiverMediaBytes,
      },
      repair: {
        nackPacketsRequestedDelta: server.nackPacketsRequested
          - previous.server.nackPacketsRequested,
        cacheHitsDelta: server.nackCacheHits - previous.server.nackCacheHits,
        cacheMissesDelta: server.nackCacheMisses - previous.server.nackCacheMisses,
      },
      backlog: {
        packetDelta: backlogPacketDelta,
        recoveredPendingMediaPackets,
        estimatedPendingMediaPackets: this.estimatedPendingMediaPackets,
      },
    };
  }
}

function nonnegativeCounter(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : null;
}

export function parseWebrtcDeliveryClientSample(
  detail: unknown,
  elapsedMs: unknown,
): WebrtcDeliveryClientSample | null {
  if (typeof detail !== "string" || detail.length > 8_192) return null;
  let value: unknown;
  try {
    value = JSON.parse(detail);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const report = value as Record<string, unknown>;
  const inbound = report.inbound;
  const path = report.path;
  if (
    typeof inbound !== "object"
    || inbound === null
    || typeof path !== "object"
    || path === null
  ) return null;
  const inboundStats = inbound as Record<string, unknown>;
  const pathStats = path as Record<string, unknown>;
  const sample = nonnegativeCounter(report.sample);
  const atMs = nonnegativeCounter(elapsedMs);
  const inboundRtpPackets = nonnegativeCounter(inboundStats.packets);
  const inboundRtpBytes = nonnegativeCounter(inboundStats.bytes);
  const candidateBytesReceived = nonnegativeCounter(pathStats.bytesReceived);
  const candidateBytesSent = nonnegativeCounter(pathStats.bytesSent);
  if (
    sample === null
    || sample < 1
    || atMs === null
    || inboundRtpPackets === null
    || inboundRtpBytes === null
    || candidateBytesReceived === null
    || candidateBytesSent === null
  ) return null;
  return {
    sample,
    elapsedMs: atMs,
    pair: typeof pathStats.pair === "string" ? pathStats.pair : null,
    pathState: typeof pathStats.state === "string" ? pathStats.state : null,
    rttMs: nonnegativeCounter(pathStats.rttMs),
    candidateBytesReceived,
    candidateBytesSent,
    inboundRtpPackets,
    inboundRtpBytes,
  };
}

export interface ConnectionDiagnostic {
  attempt: string;
  connection: number;
  windowID: string;
  createdAtMs: number;
  closedAtMs: number | null;
  iceState: string;
  connectionState: string;
  transportReady: boolean;
  sentAccessUnits: number;
  sentRtpPackets: number;
  sentRtpBytes: number;
  lastSentAtMs: number | null;
  disconnectedAtMs: number | null;
  senderRepairStats: () => RTCRtpHistoryRepairStats;
  deliveryDiagnostics: WebrtcDeliveryDiagnostics;
  pliRequests: number;
  encoder: SharedEncoder | null;
  /** Ends the peer; null until the answer has built one. */
  shutdown: ((reason: string) => void) | null;
}

export const connectionDiagnostics = new Map<string, ConnectionDiagnostic>();
const CONNECTION_DIAGNOSTIC_TTL_MS = 120_000;
const CONNECTION_DIAGNOSTIC_LIMIT = 64;

export function pruneConnectionDiagnostics(nowMs = Date.now()) {
  for (const [attempt, connection] of connectionDiagnostics) {
    if (
      connection.closedAtMs !== null
      && nowMs - connection.closedAtMs > CONNECTION_DIAGNOSTIC_TTL_MS
    ) connectionDiagnostics.delete(attempt);
  }
  while (connectionDiagnostics.size > CONNECTION_DIAGNOSTIC_LIMIT) {
    const oldestClosed = [...connectionDiagnostics.entries()]
      .find(([, connection]) => connection.closedAtMs !== null);
    const oldest = oldestClosed ?? connectionDiagnostics.entries().next().value;
    if (!oldest) break;
    connectionDiagnostics.delete(oldest[0]);
  }
}

export function serverConnectionSnapshot(attempt: string, nowMs = Date.now()): string | null {
  const connection = connectionDiagnostics.get(attempt);
  if (!connection) return null;
  const encoder = connection.encoder;
  const repair = connection.senderRepairStats();
  return `server-snapshot ${JSON.stringify({
    attempt,
    connection: connection.connection,
    windowID: connection.windowID,
    ageMs: nowMs - connection.createdAtMs,
    ice: connection.iceState,
    state: connection.connectionState,
    transportReady: connection.transportReady,
    sentAccessUnits: connection.sentAccessUnits,
    sentRtpPackets: connection.sentRtpPackets,
    sentRtpBytes: connection.sentRtpBytes,
    lastSentAgeMs: connection.lastSentAtMs === null ? -1 : nowMs - connection.lastSentAtMs,
    disconnectedAgeMs: connection.disconnectedAtMs === null
      ? -1
      : nowMs - connection.disconnectedAtMs,
    nackReports: repair.nackReports,
    nackPacketsRequested: repair.packetsRequested,
    nackCacheHits: repair.cacheHits,
    nackCacheMisses: repair.cacheMisses,
    retransmittedPacketsSent: repair.retransmittedPacketsSent,
    retransmittedBytesSent: repair.retransmittedBytesSent,
    retransmissionQueueDepth: repair.queueDepth,
    retransmissionQueueHighWaterMark: repair.queueHighWaterMark,
    retransmissionQueueBusyAgeMs: repair.queueBusyAgeMs,
    retransmissionSendFailures: repair.sendFailures,
    pliRequests: connection.pliRequests,
    encoderAccessUnits: encoder?.accessUnits,
    encoderLastAccessUnitAgeMs: !encoder || encoder.lastAccessUnitAtMs === null
      ? -1
      : nowMs - encoder.lastAccessUnitAtMs,
    encoderSubscribers: encoder?.subscribers.size,
    encoderDead: encoder?.dead,
  })}`;
}

function serverDeliverySample(connection: ConnectionDiagnostic): WebrtcDeliveryServerSample {
  const repair = connection.senderRepairStats();
  return {
    sentRtpPackets: connection.sentRtpPackets,
    sentRtpBytes: connection.sentRtpBytes,
    retransmittedPacketsSent: repair.retransmittedPacketsSent,
    retransmittedBytesSent: repair.retransmittedBytesSent,
    nackPacketsRequested: repair.packetsRequested,
    nackCacheHits: repair.cacheHits,
    nackCacheMisses: repair.cacheMisses,
  };
}

const CLIENT_PHASES = new Set([
  "answer-received",
  "answer-applied",
  "ice-state",
  "connection-state",
  "track-received",
  "play-rejected",
  "first-frame",
  "video-presentation",
  "presentation-gap",
  "receiver-stats",
  "receiver-stats-error",
  "control-channel-state",
  "control-ownership",
  "keyboard-state",
  "keyboard-focus-result",
  "keyboard-input-applied",
  "keyboard-input-rejected",
  "keyboard-buffer-overflow",
  "navigation-rejected",
  "navigation-gesture",
  "navigation-settled",
  "navigation-select",
  "navigation-display",
  "setup-timeout",
  "first-frame-timeout",
  "viewport-gesture-start",
  "viewport-gesture-end",
  "viewport-settle",
]);

export function recordClientTelemetry(
  windowID: string,
  body: TileTelemetry,
  recordDiagnostic: (line: string) => void,
): Response {
  if (
    typeof body.attempt !== "string"
    || !/^[a-zA-Z0-9-]{1,80}$/.test(body.attempt)
    || typeof body.phase !== "string"
    || !CLIENT_PHASES.has(body.phase)
  ) {
    return jsonResponse(
      { code: "webrtc-bad-telemetry", message: "invalid attempt or phase" },
      400,
    );
  }
  const detail = typeof body.detail === "string" ? body.detail.slice(0, 2_048) : undefined;
  const elapsedMs = bounded(body.elapsedMs, 0, 604_800_000);
  recordDiagnostic(
    `client ${JSON.stringify({
      windowID,
      attempt: body.attempt,
      phase: body.phase,
      detail,
      elapsedMs,
    })}`,
  );
  const connection = connectionDiagnostics.get(body.attempt);
  if (connection && (body.phase === "receiver-stats" || body.phase === "presentation-gap")) {
    const clientSample = parseWebrtcDeliveryClientSample(body.detail, elapsedMs);
    if (clientSample) {
      const correlation = connection.deliveryDiagnostics.sample(
        serverDeliverySample(connection),
        clientSample,
      );
      if (correlation) {
        recordDiagnostic(`delivery-correlation ${JSON.stringify({
          attempt: body.attempt,
          connection: connection.connection,
          windowID,
          ...correlation,
        })}`);
      }
    }
  }
  if (
    body.phase === "receiver-stats"
    || body.phase === "presentation-gap"
    || body.phase === "ice-state"
    || body.phase === "connection-state"
  ) {
    const snapshot = serverConnectionSnapshot(body.attempt);
    if (snapshot) recordDiagnostic(snapshot);
  }
  pruneConnectionDiagnostics();
  return new Response(null, { status: 204 });
}
