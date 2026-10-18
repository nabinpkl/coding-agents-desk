// What the sender wrote, what the selected pair delivered, and what the receiver got
// back -- plus the werift repair history those three are correlated against.

import { describe, expect, test } from "bun:test";
import { GenericNack, RTCPeerConnection, RTCRtpSender, RtcpTransportLayerFeedback, RtpHeader, RtpPacket } from "werift";
import {
  parseWebrtcDeliveryClientSample,
  WebrtcDeliveryDiagnostics,
  type WebrtcDeliveryClientSample,
  type WebrtcDeliveryServerSample,
} from "@/http/tile/tile-peer/webrtcTileRoutes";

describe("werift RTP repair history", () => {
  test("passes a configured history size through to each sender", async () => {
    const peer = new RTCPeerConnection({ rtpHistorySize: 1024 });
    const sender = peer.addTransceiver("video").sender as unknown as {
      rtpHistorySize: number;
    };

    expect(peer.config.rtpHistorySize).toBe(1024);
    expect(sender.rtpHistorySize).toBe(1024);
    expect(() => peer.setConfiguration({ rtpHistorySize: 2048 })).toThrow("rtpHistorySize cannot be changed");

    await peer.close();
  });

  test("reports cache misses, pending work, and send failures without polling", async () => {
    const sender = new RTCRtpSender("video", 1024);
    const senderInternals = sender as unknown as {
      rtpCache: RtpPacket[];
      dtlsTransport: { sendRtp: () => Promise<void> };
    };
    let finishRetransmission!: () => void;
    const retransmission = new Promise<void>((resolve) => {
      finishRetransmission = resolve;
    });
    senderInternals.dtlsTransport = { sendRtp: () => retransmission };
    senderInternals.rtpCache[7] = new RtpPacket(new RtpHeader({ sequenceNumber: 7 }), Buffer.from([1, 2, 3]));

    sender.handleRtcpPacket(
      new RtcpTransportLayerFeedback({
        feedback: new GenericNack({
          senderSsrc: 1,
          mediaSourceSsrc: 2,
          lost: [7, 8],
        }),
      }),
    );

    expect(sender.rtpHistoryRepairStats).toEqual({
      nackReports: 1,
      packetsRequested: 2,
      cacheHits: 1,
      cacheMisses: 1,
      retransmittedPacketsSent: 1,
      retransmittedBytesSent: 3,
      queueDepth: 1,
      queueHighWaterMark: 1,
      queueBusyAgeMs: expect.any(Number),
      sendFailures: 0,
    });

    finishRetransmission();
    await retransmission;
    await Promise.resolve();
    expect(sender.rtpHistoryRepairStats.queueDepth).toBe(0);
    expect(sender.rtpHistoryRepairStats.queueHighWaterMark).toBe(1);

    senderInternals.dtlsTransport = {
      sendRtp: () => Promise.reject(new Error("test transport failure")),
    };
    senderInternals.rtpCache[9] = new RtpPacket(new RtpHeader({ sequenceNumber: 9 }), Buffer.from([4, 5]));
    sender.handleRtcpPacket(
      new RtcpTransportLayerFeedback({
        feedback: new GenericNack({
          senderSsrc: 1,
          mediaSourceSsrc: 2,
          lost: [9],
        }),
      }),
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(sender.rtpHistoryRepairStats.sendFailures).toBe(1);
    expect(sender.rtpHistoryRepairStats.queueDepth).toBe(0);
  });
});

describe("WebRTC delivery correlation", () => {
  const sender = (overrides: Partial<WebrtcDeliveryServerSample> = {}): WebrtcDeliveryServerSample => ({
    sentRtpPackets: 100,
    sentRtpBytes: 100_000,
    retransmittedPacketsSent: 10,
    retransmittedBytesSent: 8_000,
    nackPacketsRequested: 12,
    nackCacheHits: 10,
    nackCacheMisses: 2,
    ...overrides,
  });
  const receiver = (overrides: Partial<WebrtcDeliveryClientSample> = {}): WebrtcDeliveryClientSample => ({
    sample: 1,
    elapsedMs: 1_000,
    pair: "pair-a",
    pathState: "succeeded",
    rttMs: 50,
    candidateBytesReceived: 120_000,
    candidateBytesSent: 2_000,
    inboundRtpPackets: 90,
    inboundRtpBytes: 90_000,
    ...overrides,
  });

  test("correlates sender writes, selected-pair delivery, repair, and receiver backlog", () => {
    const diagnostics = new WebrtcDeliveryDiagnostics();

    expect(diagnostics.sample(sender(), receiver())).toMatchObject({
      event: "baseline",
      pair: "pair-a",
      backlog: { estimatedPendingMediaPackets: 0 },
    });
    expect(
      diagnostics.sample(
        sender({
          sentRtpPackets: 130,
          sentRtpBytes: 130_000,
          retransmittedPacketsSent: 15,
          retransmittedBytesSent: 12_000,
          nackPacketsRequested: 20,
          nackCacheHits: 15,
          nackCacheMisses: 5,
        }),
        receiver({
          sample: 2,
          elapsedMs: 2_000,
          candidateBytesReceived: 145_000,
          candidateBytesSent: 2_500,
          inboundRtpPackets: 110,
          inboundRtpBytes: 112_000,
        }),
      ),
    ).toEqual({
      event: "sample",
      sample: 2,
      intervalMs: 1_000,
      pair: "pair-a",
      pairChanged: false,
      counterReset: false,
      path: {
        state: "succeeded",
        rttMs: 50,
        bytesReceivedDelta: 25_000,
        bytesSentDelta: 500,
      },
      sender: {
        mediaPacketsDelta: 30,
        mediaBytesDelta: 30_000,
        repairPacketsDelta: 5,
        repairBytesDelta: 4_000,
        transportWritePacketsDelta: 35,
        transportWriteBytesDelta: 34_000,
      },
      receiver: {
        mediaPacketsDelta: 20,
        mediaBytesDelta: 22_000,
      },
      repair: {
        nackPacketsRequestedDelta: 8,
        cacheHitsDelta: 5,
        cacheMissesDelta: 3,
      },
      backlog: {
        packetDelta: 10,
        recoveredPendingMediaPackets: 0,
        estimatedPendingMediaPackets: 10,
      },
    });

    const recovery = diagnostics.sample(
      sender({
        sentRtpPackets: 140,
        sentRtpBytes: 140_000,
        retransmittedPacketsSent: 20,
        retransmittedBytesSent: 16_000,
        nackPacketsRequested: 25,
        nackCacheHits: 20,
        nackCacheMisses: 5,
      }),
      receiver({
        sample: 3,
        elapsedMs: 3_000,
        candidateBytesReceived: 175_000,
        candidateBytesSent: 3_000,
        inboundRtpPackets: 135,
        inboundRtpBytes: 137_000,
      }),
    );
    expect(recovery?.backlog).toEqual({
      packetDelta: -15,
      recoveredPendingMediaPackets: 10,
      estimatedPendingMediaPackets: 0,
    });
  });

  test("coalesces sub-second reports and resets the estimate on a candidate-pair change", () => {
    const diagnostics = new WebrtcDeliveryDiagnostics();
    diagnostics.sample(sender(), receiver());

    expect(
      diagnostics.sample(
        sender({ sentRtpPackets: 105 }),
        receiver({
          sample: 2,
          elapsedMs: 1_500,
          inboundRtpPackets: 95,
        }),
      ),
    ).toBeNull();
    expect(
      diagnostics.sample(
        sender({ sentRtpPackets: 110 }),
        receiver({
          sample: 3,
          elapsedMs: 2_000,
          pair: "pair-b",
          candidateBytesReceived: 10_000,
          candidateBytesSent: 500,
          inboundRtpPackets: 100,
        }),
      ),
    ).toMatchObject({
      event: "baseline",
      sample: 3,
      pair: "pair-b",
      pairChanged: true,
      backlog: { estimatedPendingMediaPackets: 0 },
    });
    expect(diagnostics.sample(sender(), receiver({ sample: 2, elapsedMs: 1_500 }))).toBeNull();
  });

  test("parses only complete nonnegative browser counter samples", () => {
    expect(
      parseWebrtcDeliveryClientSample(
        JSON.stringify({
          sample: 7,
          inbound: { packets: 321, bytes: 456_789 },
          path: {
            pair: "pair-a",
            state: "succeeded",
            rttMs: 63,
            bytesReceived: 500_000,
            bytesSent: 7_000,
          },
        }),
        8_000,
      ),
    ).toEqual({
      sample: 7,
      elapsedMs: 8_000,
      pair: "pair-a",
      pathState: "succeeded",
      rttMs: 63,
      candidateBytesReceived: 500_000,
      candidateBytesSent: 7_000,
      inboundRtpPackets: 321,
      inboundRtpBytes: 456_789,
    });
    expect(parseWebrtcDeliveryClientSample("not-json", 8_000)).toBeNull();
    expect(parseWebrtcDeliveryClientSample("x".repeat(8_193), 8_000)).toBeNull();
    expect(
      parseWebrtcDeliveryClientSample(
        JSON.stringify({
          sample: 7,
          inbound: { packets: -1, bytes: 456_789 },
          path: { bytesReceived: 500_000, bytesSent: 7_000 },
        }),
        8_000,
      ),
    ).toBeNull();
  });
});
