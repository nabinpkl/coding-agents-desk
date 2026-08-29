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
// are the jitter buffer's problem on the far side.
//
// Spike scope: one encoder per connection (no pool sharing yet), fixed bitrate
// from the query (no bandwidth-estimate feedback into the encoder yet).

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

const WEBRTC_TILE_ROUTE = /^\/api\/park\/tile\/(\d{1,10})\/webrtc$/;

/** Kind 3 in the encoder framing: one Annex-B access unit. */
const KIND_ACCESS_UNIT = 3;

// werift negotiates by mimeType alone and adopts the browser's own H264
// entries; the fmtp below never constrains anything. Which of the browser's
// entries the sender actually stamps on packets is chosen after negotiation,
// in answer(), because the receiver enforces the profile of the payload type
// it receives.
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

  const peer = new RTCPeerConnection({ codecs: { video: [H264] } });
  const track = new MediaStreamTrack({ kind: "video" });
  const transceiver = peer.addTransceiver(track, { direction: "sendonly" });

  await peer.setRemoteDescription({ type: "offer", sdp: offer.sdp });
  const local = await peer.createAnswer();
  await peer.setLocalDescription(local);

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

  const args = [
    "--window", windowID,
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

  const child = Bun.spawn([binary, ...args], { stdout: "pipe", stderr: "pipe", stdin: "pipe" });
  let dead = false;
  const shutdown = () => {
    if (dead) return;
    dead = true;
    try {
      child.kill();
    } catch {
      // Already gone.
    }
    void peer.close();
  };

  // The transport reports peer death (ICE consent, DTLS close); that report is
  // the encoder's whole lifecycle.
  peer.connectionStateChange.subscribe((state) => {
    if (state === "failed" || state === "closed" || state === "disconnected") shutdown();
  });
  // Picture loss on the far side becomes a keyframe at the source: one byte on
  // the encoder's stdin.
  transceiver.sender.onPictureLossIndication.subscribe(() => {
    try {
      child.stdin.write("K");
    } catch {
      // Encoder gone; the state change above will shut everything down.
    }
  });
  void child.exited.then(() => shutdown());

  // Feed loop: de-frame access units, packetize, hand to the track. werift
  // rewrites SSRC and payload type to the negotiated values; sequence numbers
  // and the 90kHz timestamp are ours to keep monotonic.
  void (async () => {
    let sequence = Math.floor(Math.random() * 0xffff);
    const source = frames(child.stdout as ReadableStream<Uint8Array>);
    try {
      for await (const frame of source) {
        if (dead) break;
        if (frame.kind === KIND_META) {
          const meta = JSON.parse(new TextDecoder().decode(frame.payload)) as Record<string, unknown>;
          if (meta.type === "error") break;
          continue;
        }
        if (frame.kind !== KIND_ACCESS_UNIT || frame.payload.length < 10) continue;
        const view = new DataView(frame.payload.buffer, frame.payload.byteOffset, frame.payload.byteLength);
        const ptsMicros = view.getBigUint64(0);
        const timestamp = Number((ptsMicros * 9n) / 100n) % 0x100000000;
        const accessUnit = frame.payload.subarray(9);
        for (const { payload, last } of packetizeH264(accessUnit)) {
          const packet = new RtpPacket(
            new RtpHeader({
              sequenceNumber: sequence,
              timestamp,
              marker: last,
              payloadType: 96,
              ssrc: 0,
            }),
            Buffer.from(payload),
          );
          sequence = (sequence + 1) % 0x10000;
          track.writeRtp(packet);
        }
      }
    } catch {
      // The child died or the peer closed mid-write; shutdown covers both.
    } finally {
      shutdown();
    }
  })();

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
