// One reading of the receiver's statistics, turned into a line of telemetry.
//
// Coalescing is the point: a gap reported by the presentation watchdog and the periodic
// tick can arrive together, and only one `getStats()` may be in flight, so a second
// request is remembered rather than dropped -- and a gap reason outranks an interval one.

import { postTileTelemetry } from "@/features/desktop-viewer/tile-stream/webrtcTileWire";
import {
  classifyReceiverProgress,
  receiverProgressDelta,
  type CandidatePairStats,
  type CandidateStats,
  type ReceiverProgressSample,
  type ReceiverVideoStats,
} from "@/features/desktop-viewer/tile-stream/webrtcReceiverStats";
import type { createVideoPresentationWatch } from "@/features/desktop-viewer/tile-stream/tileVideoPresentation";
import type { AgentHttpTransport } from "@/features/activity-feed/transport/AgentHttpTransport";
import type { WebrtcTileAnswer } from "@agentdesk/agent-feed-wire";

export function createReceiverStatsSampler({
  attempt,
  element,
  httpTransport,
  isFinished,
  peer,
  presentation,
  report,
  windowID,
}: {
  attempt: string;
  element: HTMLVideoElement;
  httpTransport: Pick<AgentHttpTransport, "request"> | undefined;
  /** The session's own flag: a sample that lands after teardown says nothing. */
  isFinished: () => boolean;
  peer: RTCPeerConnection;
  presentation: ReturnType<typeof createVideoPresentationWatch>;
  report: (phase: string, detail?: string) => void;
  windowID: number | string;
}) {
  let statsInFlight = false;
  let pendingStatsReason: { reason: string; gapMs?: number } | null = null;
  let lastReceiverSample: ReceiverProgressSample | null = null;
  let lastCandidatePairID: string | null = null;
  let receiverStatsSample = 0;
  const rounded = (value: unknown, scale = 1) =>
    typeof value === "number" && Number.isFinite(value)
      ? Math.round(value * scale)
      : undefined;
  const averageMilliseconds = (total: unknown, count: unknown) =>
    typeof total === "number"
    && Number.isFinite(total)
    && typeof count === "number"
    && Number.isFinite(count)
    && count > 0
      ? Math.round((total * 1_000) / count)
      : undefined;
  const candidateDescription = (candidate: CandidateStats | undefined) => {
    if (!candidate) return "unknown";
    return [
      candidate.candidateType ?? "unknown",
      candidate.protocol ?? "unknown",
      candidate.networkType,
      candidate.relayProtocol,
      candidate.tcpType,
    ].filter(Boolean).join("/");
  };
  const sampleReceiverStats = async (reason = "interval", gapMs?: number) => {
    if (isFinished()) return;
    if (statsInFlight) {
      const isGapReason = reason === "detected"
        || reason === "progress"
        || reason === "recovered";
      const pendingIsGap = pendingStatsReason?.reason === "detected"
        || pendingStatsReason?.reason === "progress"
        || pendingStatsReason?.reason === "recovered";
      if (!pendingIsGap || isGapReason) pendingStatsReason = { reason, gapMs };
      return;
    }
    statsInFlight = true;
    try {
      const stats = await peer.getStats();
      if (isFinished()) return;
      let inbound: ReceiverVideoStats | undefined;
      let transport: RTCTransportStats | undefined;
      stats.forEach((entry) => {
        if (
          entry.type === "inbound-rtp"
          && (entry.kind === "video" || entry.mediaType === "video")
        ) {
          inbound = entry as ReceiverVideoStats;
        } else if (entry.type === "transport") {
          transport = entry as RTCTransportStats;
        }
      });
      if (!inbound) {
        report("receiver-stats-error", "no inbound video stats");
        return;
      }
      const candidatePair = transport?.selectedCandidatePairId
        ? stats.get(transport.selectedCandidatePairId) as CandidatePairStats | undefined
        : undefined;
      let selectedPair = candidatePair;
      if (!selectedPair) {
        stats.forEach((entry) => {
          const pair = entry as CandidatePairStats;
          if (
            !selectedPair
            && pair.type === "candidate-pair"
            && pair.state === "succeeded"
            && pair.nominated
          ) selectedPair = pair;
        });
      }
      const localCandidate = selectedPair?.localCandidateId
        ? stats.get(selectedPair.localCandidateId) as CandidateStats | undefined
        : undefined;
      const remoteCandidate = selectedPair?.remoteCandidateId
        ? stats.get(selectedPair.remoteCandidateId) as CandidateStats | undefined
        : undefined;
      const now = performance.now();
      const owner = presentation.owner?.attempt === attempt ? presentation.owner : null;
      const current: ReceiverProgressSample = {
        atMs: now,
        bytesReceived: rounded(inbound.bytesReceived) ?? 0,
        packetsReceived: rounded(inbound.packetsReceived) ?? 0,
        framesReceived: rounded(inbound.framesReceived) ?? 0,
        framesDecoded: rounded(inbound.framesDecoded) ?? 0,
        framesDropped: rounded(inbound.framesDropped) ?? 0,
        presentedSamples: owner?.presentedSamples ?? 0,
        connectionState: peer.connectionState,
        visibilityState: document.visibilityState,
      };
      const delta = receiverProgressDelta(lastReceiverSample, current);
      const progress = classifyReceiverProgress(lastReceiverSample, current);
      receiverStatsSample += 1;
      const pairID = selectedPair?.id ?? null;
      const pairChanged = lastCandidatePairID !== null && pairID !== lastCandidatePairID;
      const presentationGapEvent = reason === "detected"
        || reason === "progress"
        || reason === "recovered";
      lastReceiverSample = current;
      lastCandidatePairID = pairID;
      if (owner && presentationGapEvent) owner.lastGapClassification = progress;
      report(presentationGapEvent ? "presentation-gap" : "receiver-stats", JSON.stringify({
        event: reason,
        sample: receiverStatsSample,
        gapMs,
        progress,
        delta,
        peer: {
          connection: peer.connectionState,
          ice: peer.iceConnectionState,
          signaling: peer.signalingState,
          gathering: peer.iceGatheringState,
        },
        presentation: {
          document: document.visibilityState,
          presented: current.presentedSamples,
          ageMs: owner?.lastPresentedAt === null || owner?.lastPresentedAt === undefined
            ? -1
            : Math.round(now - owner.lastPresentedAt),
          readyState: element.readyState,
          paused: element.paused,
          ended: element.ended,
        },
        inbound: {
          bytes: current.bytesReceived,
          packets: current.packetsReceived,
          lost: rounded(inbound.packetsLost),
          repaired: rounded(inbound.packetsRepaired),
          discarded: rounded(inbound.packetsDiscarded),
          jitterMs: rounded(inbound.jitter, 1_000),
          received: current.framesReceived,
          decoded: current.framesDecoded,
          dropped: current.framesDropped,
          fps: rounded(inbound.framesPerSecond),
          keyframes: rounded(inbound.keyFramesDecoded),
          freezes: rounded(inbound.freezeCount),
          freezeMs: rounded(inbound.totalFreezesDuration, 1_000),
          jitterBufferMs: averageMilliseconds(
            inbound.jitterBufferDelay,
            inbound.jitterBufferEmittedCount,
          ),
          jitterTargetMs: averageMilliseconds(
            inbound.jitterBufferTargetDelay,
            inbound.jitterBufferEmittedCount,
          ),
          decodeMs: averageMilliseconds(inbound.totalDecodeTime, inbound.framesDecoded),
          nack: rounded(inbound.nackCount),
          pli: rounded(inbound.pliCount),
          decoder: inbound.decoderImplementation,
          powerEfficient: inbound.powerEfficientDecoder,
        },
        path: {
          pair: pairID?.slice(0, 16),
          changed: pairChanged,
          state: selectedPair?.state,
          nominated: selectedPair?.nominated,
          local: candidateDescription(localCandidate),
          remote: candidateDescription(remoteCandidate),
          bytesReceived: rounded(selectedPair?.bytesReceived),
          bytesSent: rounded(selectedPair?.bytesSent),
          rttMs: rounded(selectedPair?.currentRoundTripTime, 1_000),
          incomingKbps: rounded(selectedPair?.availableIncomingBitrate, 1 / 1_000),
        },
      }));
    } catch (error) {
      if (!isFinished()) {
        report(
          "receiver-stats-error",
          error instanceof Error ? error.message : String(error),
        );
      }
    } finally {
      statsInFlight = false;
      const pending = pendingStatsReason;
      pendingStatsReason = null;
      if (pending && !isFinished()) {
        void sampleReceiverStats(pending.reason, pending.gapMs);
      }
    }
  };

  return sampleReceiverStats;
}
