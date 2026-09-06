import { describe, expect, test } from "bun:test";
import {
  GenericNack,
  RTCPeerConnection,
  RTCRtpSender,
  RtcpTransportLayerFeedback,
  RtpHeader,
  RtpPacket,
} from "werift";
import {
  createWebrtcTileRoutes,
  isTerminalWebrtcConnectionState,
  parseWebrtcDeliveryClientSample,
  WebrtcDeliveryDiagnostics,
  WebrtcEncoderDiagnostics,
  type WebrtcDeliveryClientSample,
  type WebrtcDeliveryServerSample,
  writeEncoderControl,
  encoderSourceRect,
  encoderDisposition,
  encoderStreamKey,
  webrtcSessionsSnapshot,
} from "./webrtcTileRoutes.ts";

const server = undefined as never;
const diagnostics: string[] = [];
const route = createWebrtcTileRoutes((line) => diagnostics.push(line));

function telemetry(body: unknown): Promise<Response> {
  const url = new URL("http://127.0.0.1/api/park/tile/display/webrtc/telemetry");
  const request = new Request(url.toString(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return Promise.resolve(route(request, url, server)!);
}

describe("werift RTP repair history", () => {
  test("passes a configured history size through to each sender", async () => {
    const peer = new RTCPeerConnection({ rtpHistorySize: 1024 });
    const sender = peer.addTransceiver("video").sender as unknown as {
      rtpHistorySize: number;
    };

    expect(peer.config.rtpHistorySize).toBe(1024);
    expect(sender.rtpHistorySize).toBe(1024);
    expect(() => peer.setConfiguration({ rtpHistorySize: 2048 })).toThrow(
      "rtpHistorySize cannot be changed",
    );

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
    senderInternals.rtpCache[7] = new RtpPacket(
      new RtpHeader({ sequenceNumber: 7 }),
      Buffer.from([1, 2, 3]),
    );

    sender.handleRtcpPacket(new RtcpTransportLayerFeedback({
      feedback: new GenericNack({
        senderSsrc: 1,
        mediaSourceSsrc: 2,
        lost: [7, 8],
      }),
    }));

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
    senderInternals.rtpCache[9] = new RtpPacket(
      new RtpHeader({ sequenceNumber: 9 }),
      Buffer.from([4, 5]),
    );
    sender.handleRtcpPacket(new RtcpTransportLayerFeedback({
      feedback: new GenericNack({
        senderSsrc: 1,
        mediaSourceSsrc: 2,
        lost: [9],
      }),
    }));
    await Promise.resolve();
    await Promise.resolve();

    expect(sender.rtpHistoryRepairStats.sendFailures).toBe(1);
    expect(sender.rtpHistoryRepairStats.queueDepth).toBe(0);
  });
});

describe("WebRTC tile telemetry", () => {
  test("accepts bounded video presentation evidence from TypeScript", async () => {
    const response = await telemetry({
      attempt: "31e283bb-213e-4f22-89ca-e98d8e25c28a",
      phase: "video-presentation",
      detail: JSON.stringify({
        event: "sample",
        readyState: 4,
        video: "1320x856",
        trackState: "live",
        lastPresentedAgeMs: 31,
      }),
      elapsedMs: 5_000,
    });

    expect(response.status).toBe(204);
    expect(diagnostics.at(-1)).toContain('"phase":"video-presentation"');
    expect(diagnostics.at(-1)).toContain('\\"trackState\\":\\"live\\"');
  });

  test("accepts detailed presentation-gap evidence and still bounds the log line", async () => {
    const response = await telemetry({
      attempt: "31e283bb-213e-4f22-89ca-e98d8e25c28a",
      phase: "presentation-gap",
      detail: `${JSON.stringify({
        event: "detected",
        gapMs: 1_203,
        progress: "source-or-network-silent",
      })}${"x".repeat(4_096)}`,
      elapsedMs: 5_000,
    });

    expect(response.status).toBe(204);
    expect(diagnostics.at(-1)).toContain('"phase":"presentation-gap"');
    expect(diagnostics.at(-1)!.length).toBeLessThan(2_300);
  });

  test("accepts bounded viewport gesture lifecycle events from TypeScript", async () => {
    const started = await telemetry({
      attempt: "31e283bb-213e-4f22-89ca-e98d8e25c28a",
      phase: "viewport-gesture-start",
      detail: JSON.stringify({ kind: "pinch-pan", scale: 1 }),
      elapsedMs: 0,
    });
    const ended = await telemetry({
      attempt: "31e283bb-213e-4f22-89ca-e98d8e25c28a",
      phase: "viewport-gesture-end",
      detail: JSON.stringify({ kind: "pinch-pan", scale: 1.25, tx: -100, ty: -62.5 }),
      elapsedMs: 412,
    });

    expect(started.status).toBe(204);
    expect(ended.status).toBe(204);
    expect(diagnostics.at(-2)).toContain('"phase":"viewport-gesture-start"');
    expect(diagnostics.at(-1)).toContain('"phase":"viewport-gesture-end"');
  });

  test("accepts privacy-bounded desktop keyboard and ownership evidence", async () => {
    const phases = [
      "control-channel-state",
      "control-ownership",
      "keyboard-state",
      "keyboard-focus-result",
      "keyboard-input-applied",
      "keyboard-input-rejected",
      "keyboard-buffer-overflow",
    ];
    for (const phase of phases) {
      const response = await telemetry({
        attempt: "31e283bb-213e-4f22-89ca-e98d8e25c28a",
        phase,
        detail: JSON.stringify({ requestId: "request", count: 2, secure: true }),
        elapsedMs: 700,
      });
      expect(response.status).toBe(204);
      expect(diagnostics.at(-1)).toContain(`\"phase\":\"${phase}\"`);
    }
  });

  test("still rejects telemetry phases outside the explicit contract", async () => {
    const response = await telemetry({
      attempt: "31e283bb-213e-4f22-89ca-e98d8e25c28a",
      phase: "arbitrary-console-log",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      code: "webrtc-bad-telemetry",
      message: "invalid attempt or phase",
    });
  });
});

describe("WebRTC delivery correlation", () => {
  const sender = (
    overrides: Partial<WebrtcDeliveryServerSample> = {},
  ): WebrtcDeliveryServerSample => ({
    sentRtpPackets: 100,
    sentRtpBytes: 100_000,
    retransmittedPacketsSent: 10,
    retransmittedBytesSent: 8_000,
    nackPacketsRequested: 12,
    nackCacheHits: 10,
    nackCacheMisses: 2,
    ...overrides,
  });
  const receiver = (
    overrides: Partial<WebrtcDeliveryClientSample> = {},
  ): WebrtcDeliveryClientSample => ({
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
    expect(diagnostics.sample(sender({
      sentRtpPackets: 130,
      sentRtpBytes: 130_000,
      retransmittedPacketsSent: 15,
      retransmittedBytesSent: 12_000,
      nackPacketsRequested: 20,
      nackCacheHits: 15,
      nackCacheMisses: 5,
    }), receiver({
      sample: 2,
      elapsedMs: 2_000,
      candidateBytesReceived: 145_000,
      candidateBytesSent: 2_500,
      inboundRtpPackets: 110,
      inboundRtpBytes: 112_000,
    }))).toEqual({
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

    const recovery = diagnostics.sample(sender({
      sentRtpPackets: 140,
      sentRtpBytes: 140_000,
      retransmittedPacketsSent: 20,
      retransmittedBytesSent: 16_000,
      nackPacketsRequested: 25,
      nackCacheHits: 20,
      nackCacheMisses: 5,
    }), receiver({
      sample: 3,
      elapsedMs: 3_000,
      candidateBytesReceived: 175_000,
      candidateBytesSent: 3_000,
      inboundRtpPackets: 135,
      inboundRtpBytes: 137_000,
    }));
    expect(recovery?.backlog).toEqual({
      packetDelta: -15,
      recoveredPendingMediaPackets: 10,
      estimatedPendingMediaPackets: 0,
    });
  });

  test("coalesces sub-second reports and resets the estimate on a candidate-pair change", () => {
    const diagnostics = new WebrtcDeliveryDiagnostics();
    diagnostics.sample(sender(), receiver());

    expect(diagnostics.sample(sender({ sentRtpPackets: 105 }), receiver({
      sample: 2,
      elapsedMs: 1_500,
      inboundRtpPackets: 95,
    }))).toBeNull();
    expect(diagnostics.sample(sender({ sentRtpPackets: 110 }), receiver({
      sample: 3,
      elapsedMs: 2_000,
      pair: "pair-b",
      candidateBytesReceived: 10_000,
      candidateBytesSent: 500,
      inboundRtpPackets: 100,
    }))).toMatchObject({
      event: "baseline",
      sample: 3,
      pair: "pair-b",
      pairChanged: true,
      backlog: { estimatedPendingMediaPackets: 0 },
    });
    expect(diagnostics.sample(sender(), receiver({ sample: 2, elapsedMs: 1_500 })))
      .toBeNull();
  });

  test("parses only complete nonnegative browser counter samples", () => {
    expect(parseWebrtcDeliveryClientSample(JSON.stringify({
      sample: 7,
      inbound: { packets: 321, bytes: 456_789 },
      path: {
        pair: "pair-a",
        state: "succeeded",
        rttMs: 63,
        bytesReceived: 500_000,
        bytesSent: 7_000,
      },
    }), 8_000)).toEqual({
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
    expect(parseWebrtcDeliveryClientSample(JSON.stringify({
      sample: 7,
      inbound: { packets: -1, bytes: 456_789 },
      path: { bytesReceived: 500_000, bytesSent: 7_000 },
    }), 8_000)).toBeNull();
  });
});

describe("WebRTC encoder diagnostics", () => {
  test("flushes each control command instead of waiting for a full pipe buffer", () => {
    const calls: string[] = [];
    const accepted = writeEncoderControl({
      write: (line) => calls.push(`write:${line}`),
      flush: () => {
        calls.push("flush");
        return 2;
      },
    }, "K\n", (error) => calls.push(`error:${String(error)}`));

    expect(accepted).toBe(true);
    expect(calls).toEqual(["write:K\n", "flush"]);
  });

  test("separates repeated PLI requests from emitted keyframes", () => {
    const lines: string[] = [];
    const stats = new WebrtcEncoderDiagnostics("display", (line) => lines.push(line), 1_000);

    stats.recordAccessUnit(1_000, true, 1_100);
    stats.recordAccessUnit(100, false, 1_200);
    stats.recordKeyframeRequest("pli");
    stats.recordKeyframeRequest("pli");
    stats.recordKeyframeRequest("pli");
    stats.recordAccessUnit(800, true, 1_500);
    stats.flush(11_000);

    expect(lines[0]).toContain("requestContext=startup");
    expect(lines[1]).toContain("requestContext=pending-pli");
    expect(lines[1]).toContain("pendingPli=3");
    expect(lines[1]).toContain("intervalMs=400");
    expect(lines[1]).toContain("accessUnitsSincePrevious=2");
    expect(lines[2]).toContain("accessUnits=3 keyframes=2 deltas=1");
    expect(lines[2]).toContain("keyframeBytes=1800 keyframeBytePct=94.7 pliRequests=3");
    expect(lines[2]).toContain("totalAccessUnits=3 totalKeyframes=2");
  });
});

describe("WebRTC connection lifecycle", () => {
  test("keeps transient disconnects alive and closes terminal peers", () => {
    expect(isTerminalWebrtcConnectionState("connected")).toBe(false);
    expect(isTerminalWebrtcConnectionState("disconnected")).toBe(false);
    expect(isTerminalWebrtcConnectionState("failed")).toBe(true);
    expect(isTerminalWebrtcConnectionState("closed")).toBe(true);
  });
});

describe("encoderSourceRect", () => {
  test("formats a usable crop the way the helper parses it", () => {
    expect(encoderSourceRect({ x: 2400, y: 1200, width: 1920, height: 1080 }))
      .toBe("2400,1200,1920,1080");
  });

  test("rounds, because the viewport's arithmetic is fractional and display points are not", () => {
    expect(encoderSourceRect({ x: 100.4, y: 200.6, width: 640.5, height: 480.2 }))
      .toBe("100,201,641,480");
  });

  test("drops the whole crop when any part of it is unusable", () => {
    // A half-applied crop is a stream pointed confidently at the wrong part of the desktop.
    expect(encoderSourceRect({ x: 0, y: 0, width: 1920 })).toBeUndefined();
    expect(encoderSourceRect({ x: -1, y: 0, width: 1920, height: 1080 })).toBeUndefined();
    expect(encoderSourceRect({ x: 0, y: 0, width: 8, height: 1080 })).toBeUndefined();
    expect(encoderSourceRect({ x: 0, y: 0, width: 1920, height: 99999 })).toBeUndefined();
    expect(encoderSourceRect({ x: 0, y: 0, width: Number.NaN, height: 1080 })).toBeUndefined();
  });

  test("treats a missing or non-object crop as no crop at all", () => {
    expect(encoderSourceRect(undefined)).toBeUndefined();
    expect(encoderSourceRect(null)).toBeUndefined();
    expect(encoderSourceRect("2400,1200,1920,1080")).toBeUndefined();
  });
});

describe("WebRTC sessions", () => {
  function sessions(method: "GET" | "POST", path: string, body?: unknown): Promise<Response> {
    const url = new URL(`http://127.0.0.1${path}`);
    const request = new Request(url.toString(), {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return Promise.resolve(route(request, url, server)!);
  }

  test("lists nothing while no viewer or encoder is live", async () => {
    const response = await sessions("GET", "/api/park/webrtc/sessions");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ connections: [], encoders: [] });
    expect(webrtcSessionsSnapshot()).toEqual({ connections: [], encoders: [] });
  });

  test("closing is idempotent and reports what it found", async () => {
    const response = await sessions("POST", "/api/park/webrtc/sessions/close", { attempt: "no-such-attempt" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ closedConnections: [], stoppedEncoders: [] });
    const all = await sessions("POST", "/api/park/webrtc/sessions/close", { all: true });
    expect(await all.json()).toEqual({ closedConnections: [], stoppedEncoders: [] });
  });

  test("a close that names nothing, or names it badly, is refused", async () => {
    expect((await sessions("POST", "/api/park/webrtc/sessions/close", {})).status).toBe(400);
    expect((await sessions("POST", "/api/park/webrtc/sessions/close", { attempt: "bad attempt!" })).status).toBe(400);
    expect((await sessions("POST", "/api/park/webrtc/sessions/close", { encoderPid: "12" })).status).toBe(400);
  });
});

describe("one encoder per capture stream", () => {
  const wanted = { identity: "--display 224 --width 5776" };
  const running = (overrides: Partial<{ identity: string; subscribers: number }> = {}) => ({
    identity: wanted.identity,
    subscribers: 1,
    ...overrides,
  });

  test("nothing running means the offer starts the capture", () => {
    expect(encoderDisposition(undefined, wanted)).toBe("spawn");
  });

  test("an identical offer joins the running capture rather than starting a second", () => {
    expect(encoderDisposition(running(), wanted)).toBe("reuse");
  });

  test("a watched stream is joined at its own resolution, never doubled", () => {
    // The measured failure: 990 wide beside 5776 wide on one display for 557 seconds, both
    // starving. Evicting the watcher instead would have it reconnect and evict this one back.
    expect(encoderDisposition(running({ identity: "--display 224 --width 990" }), wanted)).toBe("join");
  });

  test("an unwatched stream is retasked, so the resolution knob still moves", () => {
    expect(encoderDisposition(running({ identity: "--display 224 --width 990", subscribers: 0 }), wanted))
      .toBe("retask");
  });
});

describe("what counts as a separate capture stream", () => {
  const args = (...rest: string[]) => ["--display", "224", "--codec", "h265-annexb", ...rest];

  test("a crop is its own stream, because the overview and the detail are different pixels", () => {
    expect(encoderStreamKey("display:A", args("--source-rect", "0,0,800,600")))
      .not.toBe(encoderStreamKey("display:A", args()));
    expect(encoderStreamKey("display:A", args("--source-rect", "0,0,800,600")))
      .not.toBe(encoderStreamKey("display:A", args("--source-rect", "10,0,800,600")));
  });

  test("a resolution is not, because that is the same pixels twice", () => {
    expect(encoderStreamKey("display:A", args("--width", "5776", "--fps", "15")))
      .toBe(encoderStreamKey("display:A", args("--width", "990", "--fps", "8")));
  });

  test("targets never share a stream, whatever they ask for", () => {
    expect(encoderStreamKey("display:A", args())).not.toBe(encoderStreamKey("display:B", args()));
  });
});
