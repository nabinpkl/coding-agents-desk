// `POST /api/park/tile/:windowID/webrtc` -- one window as a WebRTC video track.
//
// The transport-only bet, spelled out: the old ADR-0001 pipeline used libwebrtc
// as encoder, transport, AND renderer, and lost on software codecs. Here WebRTC
// is ONLY the transport. Our grid encoder produces hardware H.264, werift
// carries it as SRTP with the feedback machinery (NACK retransmit, PLI keyframe
// requests, connectivity checks), and the webview's built-in WebRTC stack
// hardware-decodes into the compositor. TypeScript's whole job is offer/answer
// and reframing access units into RTP payloads.
//
// What deliberately does NOT exist here, because the transport owns it: no
// live-edge chase, no buffer pruning, no idle sweeper, no reconnect policy.
// A dead peer fails ICE consent and the connection state says so; late packets
// are the jitter buffer's problem on the far side. Even the encoder's bitrate
// is the receiver's number (REMB), not ours.

import { networkInterfaces } from "node:os";
import {
  MediaStreamTrack,
  RTCPeerConnection,
  RTCRtpCodecParameters,
  RtpHeader,
  RtpPacket,
} from "werift";
import { config } from "../config.ts";
import { jsonResponse } from "./httpResponses.ts";
import type { RouteHandler } from "./route.ts";
import { frames, KIND_META } from "./tileEncoderPool.ts";
import { packetizeH264 } from "./h264Packetizer.ts";

/** The target is a window id, or the literal `display` for the whole screen. */
const WEBRTC_TILE_ROUTE = /^\/api\/park\/tile\/(\d{1,10}|display)\/webrtc$/;

// Connection diagnostics, appended per event so a failing surface (a phone on
// LTE) leaves evidence readable on the Mac without touching the device. The
// offer SDP carries every ICE candidate the remote webview gathered, which is
// the question that decides whether a path can exist at all.
let diagSequence = 0;
function diag(line: string) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("node:fs").appendFileSync(
      "/tmp/agentdesk-webrtc-diag.log",
      `${new Date().toISOString()} ${line}\n`,
    );
  } catch {
    // Diagnostics never take the path down.
  }
}
function candidateLines(sdp: string): string[] {
  return [...sdp.matchAll(/a=candidate:(\S+) (\d+) (\S+) (\d+) (\S+) (\d+) typ (\S+)/g)].map(
    (m) => `${m[3]} ${m[5]}:${m[6]} typ ${m[7]}`,
  );
}

/** Kind 3 in the encoder framing: one Annex-B access unit. */
const KIND_ACCESS_UNIT = 3;

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

// werift negotiates by mimeType alone and adopts the browser's own H264
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
const H264 = new RTCRtpCodecParameters({
  mimeType: "video/H264",
  clockRate: 90000,
  rtcpFeedback: [
    { type: "nack" },
    { type: "nack", parameter: "pli" },
    { type: "goog-remb" },
  ],
  parameters: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f",
});

/**
 * One encoder per WINDOW, shared by every viewer, keyed by window alone.
 *
 * Not an optimization: two ScreenCaptureKit captures of the same window starve
 * each other (measured on the MSE path at 48ms apart, and measured again here
 * when a reconnect overlapped the old session's encoder, which outlives its
 * dead peer by the ICE consent timeout, so BOTH captures sat at zero frames).
 * Since overlap is guaranteed by the reconnect flow, the second capture must
 * never exist. The first viewer's geometry and profile win; a later viewer of
 * the same window joins the running stream and its element scales the picture.
 */
interface SharedEncoder {
  key: string;
  child: ReturnType<typeof Bun.spawn>;
  subscribers: Set<EncoderSubscriber>;
  linger: ReturnType<typeof setTimeout> | null;
  dead: boolean;
}

interface EncoderSubscriber {
  /** One access-unit payload: 8 bytes pts-microseconds, 1 keyframe byte, Annex-B. */
  onAccessUnit: (payload: Uint8Array) => void;
  /** The encoder died; the connection has nothing left to send. */
  onDead: () => void;
}

const sharedEncoders = new Map<string, SharedEncoder>();
const ENCODER_LINGER_MS = 3_000;

function encoderStdin(shared: SharedEncoder, line: string) {
  const stdin = shared.child.stdin;
  if (!stdin || typeof stdin === "number") return;
  try {
    stdin.write(line);
  } catch {
    // Dying encoder; its exit handler tears the subscribers down.
  }
}

function killSharedEncoder(shared: SharedEncoder) {
  if (shared.dead) return;
  shared.dead = true;
  if (sharedEncoders.get(shared.key) === shared) sharedEncoders.delete(shared.key);
  if (shared.linger) clearTimeout(shared.linger);
  try {
    shared.child.kill();
  } catch {
    // Already gone.
  }
  for (const subscriber of [...shared.subscribers]) subscriber.onDead();
  shared.subscribers.clear();
}

function acquireSharedEncoder(windowID: string, binary: string, args: string[]): SharedEncoder {
  const existing = sharedEncoders.get(windowID);
  if (existing && !existing.dead) return existing;

  const child = Bun.spawn([binary, ...args], { stdout: "pipe", stderr: "pipe", stdin: "pipe" });
  const shared: SharedEncoder = {
    key: windowID,
    child,
    subscribers: new Set(),
    linger: null,
    dead: false,
  };
  sharedEncoders.set(windowID, shared);

  void child.exited.then(() => killSharedEncoder(shared));
  void (async () => {
    try {
      for await (const frame of frames(child.stdout as ReadableStream<Uint8Array>)) {
        if (shared.dead) break;
        if (frame.kind === KIND_META) {
          const meta = JSON.parse(new TextDecoder().decode(frame.payload)) as Record<string, unknown>;
          if (meta.type === "error") break;
          continue;
        }
        if (frame.kind !== KIND_ACCESS_UNIT || frame.payload.length < 10) continue;
        for (const subscriber of shared.subscribers) subscriber.onAccessUnit(frame.payload);
      }
    } catch {
      // Reader failure is death; the finally covers it.
    } finally {
      killSharedEncoder(shared);
    }
  })();
  return shared;
}

function subscribeSharedEncoder(shared: SharedEncoder, subscriber: EncoderSubscriber): () => void {
  if (shared.linger) {
    clearTimeout(shared.linger);
    shared.linger = null;
  }
  shared.subscribers.add(subscriber);
  // A joining viewer needs a keyframe to start decoding; ask the running
  // encoder for one rather than making the viewer wait out the GOP.
  encoderStdin(shared, "K\n");
  let released = false;
  return () => {
    if (released) return;
    released = true;
    shared.subscribers.delete(subscriber);
    if (shared.subscribers.size === 0 && !shared.dead && !shared.linger) {
      shared.linger = setTimeout(() => {
        if (shared.subscribers.size === 0) killSharedEncoder(shared);
      }, ENCODER_LINGER_MS);
    }
  };
}

interface TileOffer {
  sdp?: string;
  type?: string;
  width?: number;
  height?: number;
  fps?: number;
  bitrate?: number;
}

function bounded(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return value >= min && value <= max ? Math.round(value) : undefined;
}

async function answer(windowID: string, offer: TileOffer): Promise<Response> {
  const binary = config.gridEncoderPath;
  if (!binary || !(await Bun.file(binary).exists())) {
    return jsonResponse(
      { code: "tile-encoder-missing", message: `no grid encoder at ${binary}` },
      503,
    );
  }
  if (!offer.sdp || offer.type !== "offer") {
    return jsonResponse({ code: "webrtc-bad-offer", message: "body must carry an SDP offer" }, 400);
  }

  const tailnet = tailnetIPv4();
  const peer = new RTCPeerConnection({
    codecs: { video: [H264] },
    iceAdditionalHostAddresses: tailnet ? [tailnet] : undefined,
  });
  const track = new MediaStreamTrack({ kind: "video" });
  const transceiver = peer.addTransceiver(track, { direction: "sendonly" });

  const connection = ++diagSequence;
  diag(`c${connection} window=${windowID} offer candidates: ${candidateLines(offer.sdp).join(" | ") || "NONE"}`);

  await peer.setRemoteDescription({ type: "offer", sdp: offer.sdp });
  const local = await peer.createAnswer();
  await peer.setLocalDescription(local);
  diag(`c${connection} answer candidates: ${candidateLines(peer.localDescription!.sdp).join(" | ") || "NONE"}`);
  peer.iceConnectionStateChange.subscribe((state) => {
    diag(`c${connection} ice=${state}`);
  });

  // werift negotiates by mimeType and keeps the browser's own H264 entries,
  // defaulting the sender to the first one -- typically Baseline. The browser
  // enforces the profile of the payload type it receives (measured: High bits
  // on a Baseline PT decode zero frames), so sending better-than-Baseline text
  // means SELECTING the browser's own High entry and encoding to match it.
  // Preference order: High (64), Constrained High (f4), then whatever
  // packetization-mode=1 entry remains.
  const negotiated = transceiver.codecs.filter(
    (codec) => codec.mimeType.toLowerCase() === "video/h264"
      && (codec.parameters ?? "").includes("packetization-mode=1"),
  );
  const high = negotiated.find((codec) => /profile-level-id=(64|f4)/i.test(codec.parameters ?? ""));
  const chosen = high ?? negotiated[0];
  if (chosen) {
    transceiver.sender.codec = chosen;
    track.codec = chosen;
  }
  const profile = high ? "high" : "cb";
  diag(`c${connection} codec pt=${chosen?.payloadType} profile=${profile} size=${offer.width}x${offer.height} bitrate=${offer.bitrate}`);

  const args = [
    ...(windowID === "display" ? ["--display", "main"] : ["--window", windowID]),
    "--codec", "h264-annexb",
    // A 4-second GOP instead of the MSE path's 0.4s: that cadence was a
    // segment constraint, not a transport need, and at tile bitrates a
    // keyframe every 0.4s spends the whole budget on refreshes so static text
    // never sharpens. Joins and loss recovery are PLI's job here, not the GOP's.
    "--segment", "4",
    "--profile", profile,
  ];
  const width = bounded(offer.width, 16, 7680);
  const height = bounded(offer.height, 16, 4320);
  const fps = bounded(offer.fps, 1, 60);
  const bitrate = bounded(offer.bitrate, 100_000, 40_000_000);
  if (width) args.push("--width", String(width));
  if (height) args.push("--height", String(height));
  if (fps) args.push("--fps", String(fps));
  if (bitrate) args.push("--bitrate", String(bitrate));

  const shared = acquireSharedEncoder(windowID, binary, args);
  let dead = false;
  let release: () => void = () => {};
  const shutdown = () => {
    if (dead) return;
    dead = true;
    release();
    void peer.close();
  };

  // The transport reports peer death (ICE consent, DTLS close); that report is
  // this subscription's whole lifecycle. The shared encoder itself dies a few
  // seconds after its last subscriber.
  peer.connectionStateChange.subscribe((state) => {
    diag(`c${connection} connection=${state}`);
    if (state === "failed" || state === "closed" || state === "disconnected") shutdown();
  });
  // Picture loss on the far side becomes a keyframe at the source. Every
  // viewer gets the refresh, which is what sharing a capture means.
  transceiver.sender.onPictureLossIndication.subscribe(() => {
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
  let sequence = Math.floor(Math.random() * 0xffff);
  release = subscribeSharedEncoder(shared, {
    onAccessUnit: (payload) => {
      if (dead) return;
      const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
      const ptsMicros = view.getBigUint64(0);
      const timestamp = Number((ptsMicros * 9n) / 100n) % 0x100000000;
      const accessUnit = payload.subarray(9);
      for (const { payload: rtpPayload, last } of packetizeH264(accessUnit)) {
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
      }
    },
    onDead: shutdown,
  });

  // Vanilla ICE: werift resolves setLocalDescription after gathering, so the
  // answer already carries the host candidates and no trickle round-trips are
  // needed over the signaling channel.
  return jsonResponse({ type: "answer", sdp: peer.localDescription!.sdp });
}

export function createWebrtcTileRoutes(): RouteHandler {
  return (request, url) => {
    if (request.method !== "POST") return undefined;
    const match = WEBRTC_TILE_ROUTE.exec(url.pathname);
    if (!match) return undefined;
    return (async () => {
      let body: TileOffer;
      try {
        body = (await request.json()) as TileOffer;
      } catch {
        return jsonResponse({ code: "webrtc-bad-offer", message: "body was not JSON" }, 400);
      }
      return answer(match[1]!, body).catch((error: unknown) =>
        jsonResponse(
          {
            code: "webrtc-tile-failed",
            message: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
          },
          500,
        ),
      );
    })();
  };
}
