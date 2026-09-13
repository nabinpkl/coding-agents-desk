// Building one peer for one capture: the offer in, the answer out.
//
// The long function this file is for is a sequence, not a structure -- validate the target,
// negotiate a codec, start or join the encoder, wire the sender, hand back the SDP -- and it is
// written as one because every step depends on the one before and the failure of any of them is
// a different status code. What it delegates is what has a life of its own: the encoder pool,
// the control channel, and the diagnostics record for this attempt.

import type {
  DesktopControlEvent,
  WebrtcTileAnswer,
  WebrtcTileSourceMetadata,
} from "@agentdesk/agent-feed-wire";
import { networkInterfaces } from "node:os";
import { desktopDisplayId } from "@agentdesk/agent-feed-wire";
import {
  MediaStreamTrack,
  RTCPeerConnection,
  RTCRtpCodecParameters,
  RtpHeader,
  RtpPacket,
} from "werift";
import { config } from "../config.ts";
import { controlHelper } from "../desktop/controlHelper.ts";
import { helperBinary, missingHelperMessage } from "../desktop/helperBinary.ts";
import { jsonResponse } from "./httpResponses.ts";
import { packetizeH264 } from "./h264Packetizer.ts";
import { packetizeH265 } from "./h265Packetizer.ts";
import { resolveDisplayTarget, DisplayTargetUnavailable } from "./webrtcDisplayTarget.ts";
import { chooseTileVideoCodec } from "./webrtcTileCodec.ts";
import {
  candidateLines,
  diag,
  nextDiagSequence,
} from "./webrtcDiagnosticsLog.ts";
import {
  connectionDiagnostics,
  pruneConnectionDiagnostics,
  WebrtcDeliveryDiagnostics,
  type ConnectionDiagnostic,
} from "./webrtcConnectionDiagnostics.ts";
import {
  acquireSharedEncoder,
  encoderStdin,
  killSharedEncoder,
  liveEncodersForTarget,
  primeSubscriber,
  subscribeSharedEncoder,
  waitForEncoderMetadata,
  type EncoderSubscriber,
  type SharedEncoder,
} from "./webrtcEncoderPool.ts";
import { encoderStreamKey } from "./webrtcEncoderIdentity.ts";
import { createTileControl } from "./webrtcTileControl.ts";
import {
  ATTEMPT_PATTERN,
  bounded,
  encoderSourceRect,
  type TileOffer,
} from "./webrtcTileOffer.ts";
import { isTerminalWebrtcConnectionState } from "./webrtcConnectionState.ts";
import { releaseSupersededViewer } from "./webrtcSessions.ts";

/**
 * The Mac's tailnet address, derived from the CGNAT range tailscale uses.
 *
 * werift's own interface scan skips utun devices, so without this the answer
 * advertises only the LAN address, public IPv6, and a STUN reflexive -- none
 * of which a phone on LTE can reach (measured: exactly that candidate list,
 * and a phone that connected on the home WiFi but only ever said reconnecting
 * on LTE). The tailnet address is the one path that exists regardless of what
 * network either end sits on; the phone's checks toward it route through its
 * own tunnel, and the reply address they arrive from gives werift the working
 * pair. Re-read per connection, because tailscale can come up after the
 * sidecar did.
 */
function tailnetIPv4(): string | null {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== "IPv4") continue;
      const octets = address.address.split(".").map(Number);
      if (octets[0] === 100 && octets[1]! >= 64 && octets[1]! <= 127) return address.address;
    }
  }
  return null;
}

// werift negotiates by mimeType alone and adopts the browser's own codec
// entries; the fmtp below never constrains anything. Which of the browser's
// entries the sender actually stamps on packets is chosen after negotiation,
// in answer(), because the receiver enforces the profile of the payload type
// it receives.
//
// Deliberately NO transport-wide-cc header extension. Negotiating it makes the
// browser use TWCC feedback, which feeds werift's sender-side estimator, and
// that estimator assumes a saturating sender: it emits only on windows of
// twenty-plus acked packets and reads a quiet second as congestion, so a
// mostly-static window never produces an estimate at all (measured: 191 TWCC
// feedbacks in, zero estimates out). Without TWCC the browser falls back to
// REMB, its own receiver-side estimator telling us a number directly, which is
// both the more battle-tested estimator and the more minimal arrangement: the
// receiver decides, the encoder obeys.
const RTCP_FEEDBACK = [
  { type: "nack" },
  { type: "nack", parameter: "pli" },
  { type: "goog-remb" },
];

const H265 = new RTCRtpCodecParameters({
  mimeType: "video/H265",
  clockRate: 90000,
  rtcpFeedback: RTCP_FEEDBACK,
  // These are RFC 7798's defaults, stated explicitly so our packetizer's
  // absence of DONL/DOND and its one-stream ordering contract are visible.
  parameters: "tx-mode=SRST;sprop-max-don-diff=0",
});

const H264 = new RTCRtpCodecParameters({
  mimeType: "video/H264",
  clockRate: 90000,
  rtcpFeedback: RTCP_FEEDBACK,
  parameters: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f",
});

export async function answer(windowID: string, offer: TileOffer, signal: AbortSignal): Promise<Response> {
  const { path: binary, mtimeMs: binaryMtimeMs, exists } = helperBinary();
  if (!exists) {
    return jsonResponse(
      { code: "tile-encoder-missing", message: missingHelperMessage(binary) },
      503,
    );
  }
  if (!offer.sdp || offer.type !== "offer") {
    return jsonResponse({ code: "webrtc-bad-offer", message: "body must carry an SDP offer" }, 400);
  }
  if (offer.displayId !== undefined && (windowID !== "display" || !desktopDisplayId(offer.displayId))) {
    return jsonResponse({ code: "webrtc-bad-offer", message: "invalid display selection" }, 400);
  }
  let captureKey = windowID;
  let captureId: number | undefined;
  let captureDisplayId: string | undefined;
  if (windowID === "display") {
    try {
      const target = await resolveDisplayTarget(offer.displayId, () => controlHelper.request("desktop-displays"));
      captureKey = target.key;
      captureId = target.captureId;
      captureDisplayId = target.displayId;
    } catch (error) {
      const code = error instanceof DisplayTargetUnavailable ? error.code : "navigation-unavailable";
      return jsonResponse({ code, message: code,
        ...(error instanceof DisplayTargetUnavailable && error.replacementDisplayId
          ? { replacementDisplayId: error.replacementDisplayId } : {}) }, 409);
    }
  }
  if (offer.attempt !== undefined && !ATTEMPT_PATTERN.test(offer.attempt)) {
    return jsonResponse({ code: "webrtc-bad-offer", message: "attempt was invalid" }, 400);
  }
  if (offer.supersedes !== undefined && !ATTEMPT_PATTERN.test(offer.supersedes)) {
    return jsonResponse({ code: "webrtc-bad-offer", message: "supersedes was invalid" }, 400);
  }

  if (signal.aborted) return jsonResponse({ code: "offer-cancelled" }, 499);
  const tailnet = tailnetIPv4();
  const peer = new RTCPeerConnection({
    codecs: { video: [H265, H264] },
    iceAdditionalHostAddresses: tailnet ? [tailnet] : undefined,
    rtpHistorySize: config.webrtcRtpHistoryPackets,
  });
  const track = new MediaStreamTrack({ kind: "video" });
  const transceiver = peer.addTransceiver(track, { direction: "sendonly" });
  const connection = nextDiagSequence();
  const attempt = offer.attempt ?? `server-c${connection}`;
  const connectionDiagnostic: ConnectionDiagnostic = {
    attempt,
    connection,
    windowID,
    createdAtMs: Date.now(),
    closedAtMs: null,
    iceState: "new",
    connectionState: "new",
    transportReady: false,
    sentAccessUnits: 0,
    sentRtpPackets: 0,
    sentRtpBytes: 0,
    lastSentAtMs: null,
    disconnectedAtMs: null,
    senderRepairStats: () => transceiver.sender.rtpHistoryRepairStats,
    deliveryDiagnostics: new WebrtcDeliveryDiagnostics(),
    pliRequests: 0,
    encoder: null,
    shutdown: null,
  };
  connectionDiagnostics.set(attempt, connectionDiagnostic);
  pruneConnectionDiagnostics();
  const closeConnectionDiagnostic = () => {
    if (connectionDiagnostic.closedAtMs === null) connectionDiagnostic.closedAtMs = Date.now();
    connectionDiagnostic.transportReady = false;
    connectionDiagnostic.disconnectedAtMs = null;
  };
  const control = createTileControl({ captureDisplayId, connection, peer });
  const inputOwner = control.inputOwner;
  const sendControl = control.send;
  const releaseInputOwner = control.release;

  diag(`c${connection} window=${windowID} offer candidates: ${candidateLines(offer.sdp).join(" | ") || "NONE"}`);

  await peer.setRemoteDescription({ type: "offer", sdp: offer.sdp });
  diag(`c${connection} offered-codecs=${transceiver.codecs.map(
    (codec) => `${codec.mimeType}:${codec.payloadType}:${codec.parameters ?? ""}`,
  ).join(" | ")}`);
  // Every encoder of one target shares a codec: the hardware encoder is one resource, and a
  // viewer running a coarse and a sharp stream of the same display should not pay for two.
  const activeCodec = liveEncodersForTarget(captureKey)[0]?.codec;
  let choice = chooseTileVideoCodec(transceiver.codecs, activeCodec);
  if (!choice) {
    closeConnectionDiagnostic();
    void peer.close();
    return jsonResponse({
      code: "webrtc-codec-unavailable",
      message: activeCodec
        ? `browser did not offer the active ${activeCodec} shared-stream codec`
        : "browser did not offer supported H.265 SRST or H.264 packetization-mode=1",
    }, 415);
  }
  transceiver.sender.codec = choice.negotiated;
  track.codec = choice.negotiated;

  const local = await peer.createAnswer();
  await peer.setLocalDescription(local);
  if (signal.aborted) {
    closeConnectionDiagnostic();
    void peer.close();
    return jsonResponse({ code: "offer-cancelled" }, 499);
  }
  diag(`c${connection} answer candidates: ${candidateLines(peer.localDescription!.sdp).join(" | ") || "NONE"}`);
  peer.iceConnectionStateChange.subscribe((state) => {
    connectionDiagnostic.iceState = state;
    diag(`c${connection} ice=${state}`);
  });

  // Another offer can finish while certificates and ICE are being prepared.
  // Re-check synchronously before acquiring so both connections cannot create
  // different codecs for the one-window/one-capture authority.
  const nowActiveCodec = liveEncodersForTarget(captureKey)[0]?.codec;
  if (nowActiveCodec && nowActiveCodec !== choice.kind) {
    const activeChoice = chooseTileVideoCodec(transceiver.codecs, nowActiveCodec);
    if (!activeChoice) {
      closeConnectionDiagnostic();
      void peer.close();
      return jsonResponse({
        code: "webrtc-codec-unavailable",
        message: `browser did not offer the active ${nowActiveCodec} shared-stream codec`,
      }, 415);
    }
    choice = activeChoice;
    transceiver.sender.codec = choice.negotiated;
    track.codec = choice.negotiated;
  }

  const profile = choice.h264Profile ?? "main";
  diag(`c${connection} codec=${choice.kind} pt=${choice.negotiated.payloadType} profile=${profile} size=${offer.width}x${offer.height} bitrate=${offer.bitrate} rtpHistoryPackets=${config.webrtcRtpHistoryPackets}`);

  const args = [
    ...(windowID === "display" ? ["--display", String(captureId)] : ["--window", windowID]),
    "--codec", choice.kind === "h265" ? "h265-annexb" : "h264-annexb",
    // RTP has no segment boundary to satisfy. A joining viewer receives the
    // retained bootstrap and requests a fresh keyframe; loss recovery does the
    // same through PLI. VideoToolbox's low-latency mode keeps that GOP infinite,
    // because periodic keyframes only create unrequested LTE bursts.
  ];
  if (choice.kind === "h264") args.push("--profile", profile);
  const width = bounded(offer.width, 16, 7680);
  const height = bounded(offer.height, 16, 4320);
  const fps = bounded(offer.fps, 1, 60);
  const bitrate = bounded(offer.bitrate, 100_000, 40_000_000);
  // A crop belongs to a display capture; a window capture is already one rectangle, and the helper
  // rejects the combination rather than quietly picking one.
  const sourceRect = windowID === "display" ? encoderSourceRect(offer.sourceRect) : undefined;
  if (sourceRect) args.push("--source-rect", sourceRect);
  if (width) args.push("--width", String(width));
  if (height) args.push("--height", String(height));
  if (fps) args.push("--fps", String(fps));
  if (bitrate) args.push("--bitrate", String(bitrate));

  // Only a predecessor on this very stream is released here. A display handover's predecessor is
  // on another target and a re-aim's is on another crop; neither contends for this capture, and
  // both keep the gapless overlap they were retired for.
  if (offer.supersedes !== undefined) {
    releaseSupersededViewer(offer.supersedes, encoderStreamKey(captureKey, args));
  }

  // One retry, because a wedged capture is recoverable and a viewer switching monitors is not
  // patient. Draining teardowns before a spawn makes the starve rare, but ScreenCaptureKit can
  // still hand back a stream that never produces a frame; the helper only reports that by dying,
  // and by then the offer is already lost. A second attempt starts from a settled machine, so it
  // either works or fails for a reason worth surfacing.
  let shared!: SharedEncoder;
  let source!: WebrtcTileSourceMetadata;
  for (let attempt = 1; ; attempt += 1) {
    shared = await acquireSharedEncoder(captureKey, binary, binaryMtimeMs, args, choice.kind);
    control.encoder = shared;
    connectionDiagnostic.encoder = shared;
    try {
      source = await waitForEncoderMetadata(shared);
      if (captureDisplayId && source.displayId !== captureDisplayId) {
        throw new Error("capture display identity does not match the requested monitor");
      }
      break;
    } catch (error) {
      killSharedEncoder(shared, "source-metadata-unavailable");
      // Only a capture that never spoke is worth starting again. A display that answered with the
      // wrong identity, or a cancelled offer, would fail the same way twice.
      const retryable = attempt === 1 && !signal.aborted && !(error instanceof Error
        && error.message.startsWith("capture display identity"));
      if (!retryable) {
        closeConnectionDiagnostic();
        void peer.close();
        throw error;
      }
      diag(`c${connection} encoder key=${captureKey} retrying after ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  let dead = false;
  let release: () => void = () => {};
  const shutdown = (reason: string) => {
    if (dead) return;
    dead = true;
    closeConnectionDiagnostic();
    diag(`c${connection} shutdown reason=${reason}`);
    releaseInputOwner();
    release();
    void peer.close();
  };
  connectionDiagnostic.shutdown = shutdown;

  // NACK is the delta-preserving repair path. The patched sender owns exact
  // cache hit, miss, pending-send, high-water, and failure counters; snapshots
  // read them synchronously so telemetry never polls or races an async stats refresh.
  transceiver.sender.onPictureLossIndication.subscribe(() => {
    connectionDiagnostic.pliRequests += 1;
    shared.videoDiagnostics.recordKeyframeRequest("pli");
    encoderStdin(shared, "K\n");
  });
  // The receiver's bandwidth estimate drives the encoder's bitrate, which
  // retires the last hand-set number in this path: the page's request is only
  // the seed until the first REMB lands. With several viewers the last
  // estimate wins, which slightly favours whoever spoke most recently; the
  // honest multi-viewer answer (minimum across viewers) can land with the
  // grid. Updates under a tenth of the last applied value are noise and
  // skipped.
  let appliedBitrate = 0;
  const applyEstimate = (estimate: number) => {
    if (!Number.isFinite(estimate) || estimate <= 0) return;
    // The floor matters more than it looks: a quiet window sends almost
    // nothing, REMB can only estimate what it measures, so quiet-time
    // estimates read tens of kilobits. That is absence of evidence, not a bad
    // link, and obeying it would start every burst of motion at slideshow
    // quality. From the floor, GCC's multiplicative ramp recovers the real
    // capacity within seconds of traffic flowing.
    const clamped = Math.max(300_000, Math.min(20_000_000, Math.round(estimate)));
    if (appliedBitrate > 0 && Math.abs(clamped - appliedBitrate) / appliedBitrate < 0.1) return;
    appliedBitrate = clamped;
    encoderStdin(shared, `B${clamped}\n`);
  };
  transceiver.sender.onRtcp.subscribe((rtcp) => {
    const feedback = (rtcp as { feedback?: { bitrate?: bigint } }).feedback;
    if (feedback && typeof feedback.bitrate === "bigint") applyEstimate(Number(feedback.bitrate));
  });

  // Feed: packetize each shared access unit into this connection's track.
  // werift rewrites SSRC and payload type to the negotiated values; sequence
  // numbers and the 90kHz timestamp are ours to keep monotonic per connection.
  const randomStart = crypto.getRandomValues(new Uint32Array(2));
  let sequence = randomStart[0]! & 0xffff;
  const timestampOffset = randomStart[1]!;
  let sentAccessUnits = 0;
  let transportReady = false;
  const subscriber: EncoderSubscriber = {
    inputOwner,
    onAccessUnit: (payload) => {
      if (dead || !transportReady) return;
      sentAccessUnits += 1;
      connectionDiagnostic.sentAccessUnits = sentAccessUnits;
      if (sentAccessUnits === 1) {
        diag(`c${connection} first-access-unit bytes=${payload.length} keyframe=${payload[8] === 1}`);
      }
      const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
      const ptsMicros = view.getBigUint64(0);
      const timestamp = Number((BigInt(timestampOffset) + ((ptsMicros * 9n) / 100n)) & 0xffff_ffffn);
      const accessUnit = payload.subarray(9);
      const rtpPayloads = choice.kind === "h265"
        ? packetizeH265(accessUnit)
        : packetizeH264(accessUnit);
      for (const { payload: rtpPayload, last } of rtpPayloads) {
        const packet = new RtpPacket(
          new RtpHeader({
            sequenceNumber: sequence,
            timestamp,
            marker: last,
            payloadType: 96,
            ssrc: 0,
          }),
          Buffer.from(rtpPayload),
        );
        sequence = (sequence + 1) % 0x10000;
        track.writeRtp(packet);
        connectionDiagnostic.sentRtpPackets += 1;
        connectionDiagnostic.sentRtpBytes += rtpPayload.length;
        connectionDiagnostic.lastSentAtMs = Date.now();
      }
    },
    onControl: sendControl,
    onDead: () => shutdown("encoder-dead"),
  };
  release = subscribeSharedEncoder(shared, subscriber);
  if (signal.aborted) {
    shutdown("offer-cancelled");
    return jsonResponse({ code: "offer-cancelled" }, 499);
  }
  if (control.isOpen()) {
    for (const event of shared.controlEvents.snapshot()) sendControl(event);
  }

  // The transport reports peer death (ICE consent, DTLS close); that report is
  // this subscription's whole lifecycle. Bootstrap only after DTLS is ready so
  // the retained keyframe cannot be written before the peer can receive RTP.
  peer.connectionStateChange.subscribe((state) => {
    connectionDiagnostic.connectionState = state;
    diag(`c${connection} connection=${state}`);
    if (state === "disconnected") {
      if (connectionDiagnostic.disconnectedAtMs === null) {
        connectionDiagnostic.disconnectedAtMs = Date.now();
        diag(`c${connection} transient-disconnect awaiting ICE recovery`);
      }
      return;
    }
    if (state === "connected" && !transportReady) {
      transportReady = true;
      connectionDiagnostic.transportReady = true;
      primeSubscriber(shared, subscriber);
    }
    if (state === "connected") {
      const disconnectedAtMs = connectionDiagnostic.disconnectedAtMs;
      if (disconnectedAtMs !== null) {
        connectionDiagnostic.disconnectedAtMs = null;
        diag(`c${connection} transient-disconnect recovered durationMs=${Date.now() - disconnectedAtMs}`);
      }
    }
    // `disconnected` is explicitly transient. The browser owns its eight-second
    // reconnect window, while werift's RFC 7675 consent lifecycle eventually
    // turns an unrecoverable path into `failed`. Closing earlier prevents both.
    if (isTerminalWebrtcConnectionState(state)) shutdown(`connection-${state}`);
  });

  // Vanilla ICE: werift resolves setLocalDescription after gathering, so the
  // answer already carries the host candidates and no trickle round-trips are
  // needed over the signaling channel.
  const response: WebrtcTileAnswer = {
    type: "answer",
    sdp: peer.localDescription!.sdp,
    codec: choice.kind,
    source,
  };
  return jsonResponse(response);
}
