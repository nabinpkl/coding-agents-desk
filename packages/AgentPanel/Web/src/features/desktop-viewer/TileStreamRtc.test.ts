import { describe, expect, it } from "vitest";
import {
  classifyReceiverProgress,
  parseWebrtcTileAnswer,
  RECEIVER_STATS_INTERVAL_MS,
  receiverProgressDelta,
  type ReceiverProgressSample,
  tileCaptureSize,
} from "./TileStreamRtc";

const progress = (overrides: Partial<ReceiverProgressSample> = {}): ReceiverProgressSample => ({
  atMs: 1_000,
  bytesReceived: 10_000,
  packetsReceived: 100,
  framesReceived: 60,
  framesDecoded: 60,
  framesDropped: 0,
  presentedSamples: 60,
  connectionState: "connected",
  visibilityState: "visible",
  ...overrides,
});

describe("receiver freeze classification", () => {
  const previous = progress();

  it("separates network silence from browser pipeline stalls", () => {
    expect(classifyReceiverProgress(previous, progress({ atMs: 2_000 })))
      .toBe("source-or-network-silent");
    expect(classifyReceiverProgress(previous, progress({
      atMs: 2_000,
      bytesReceived: 12_000,
      packetsReceived: 120,
    }))).toBe("rtp-frame-assembly-stalled");
    expect(classifyReceiverProgress(previous, progress({
      atMs: 2_000,
      bytesReceived: 12_000,
      packetsReceived: 120,
      framesReceived: 75,
    }))).toBe("decoder-stalled");
    expect(classifyReceiverProgress(previous, progress({
      atMs: 2_000,
      bytesReceived: 12_000,
      packetsReceived: 120,
      framesReceived: 75,
      framesDecoded: 75,
    }))).toBe("presentation-stalled");
  });

  it("makes page visibility and peer death explicit before counter analysis", () => {
    expect(classifyReceiverProgress(previous, progress({ visibilityState: "hidden" })))
      .toBe("page-hidden");
    expect(classifyReceiverProgress(previous, progress({ connectionState: "disconnected" })))
      .toBe("transport-disconnected");
  });

  it("reports exact deltas over the sampled window", () => {
    expect(receiverProgressDelta(previous, progress({
      atMs: 2_200,
      bytesReceived: 12_500,
      packetsReceived: 125,
      framesReceived: 74,
      framesDecoded: 73,
      framesDropped: 1,
      presentedSamples: 72,
    }))).toEqual({
      intervalMs: 1_200,
      bytes: 2_500,
      packets: 25,
      received: 14,
      decoded: 13,
      dropped: 1,
      presented: 12,
    });
  });
});

describe("receiver diagnostic cadence", () => {
  it("samples the WebRTC delivery path once per second", () => {
    expect(RECEIVER_STATS_INTERVAL_MS).toBe(1_000);
  });
});

describe("tileCaptureSize", () => {
  it("uses a width-only request before display aspect metadata exists", () => {
    expect(tileCaptureSize(390, undefined, undefined, 3, 1_200_000)).toEqual({
      width: 1170,
      bitrate: 1_200_000,
    });
  });

  it("prices the request from the picture it asks for, not from the multiplier", () => {
    // 1170x760 at 15fps and 0.12 bits per pixel. Scaling a fixed budget by the multiplier instead
    // made every extra pixel share the same bits, so raising the resolution softened a still
    // desktop rather than sharpening it.
    expect(tileCaptureSize(390, 1800, 1169, 3, 1_200_000)).toEqual({
      width: 1170,
      height: 760,
      bitrate: 1_600_560,
    });
  });

  it("lets the resolution knob push capture toward source-native, but no further", () => {
    // 2x the auto scale would exceed the source, so it clamps at native and the bitrate with it.
    expect(tileCaptureSize(390, 1800, 1169, 3, 1_200_000, 2)).toEqual({
      width: 1800,
      height: 1169,
      bitrate: 3_787_560,
    });
  });

  it("lets the knob trade resolution for a thinner stream, priced down with it", () => {
    expect(tileCaptureSize(390, 1800, 1169, 3, 1_200_000, 0.5)).toEqual({
      width: 585,
      height: 380,
      bitrate: 400_140,
    });
  });
});

describe("parseWebrtcTileAnswer", () => {
  it("accepts source geometry and cursor in logical display points", () => {
    expect(parseWebrtcTileAnswer(JSON.stringify({
      type: "answer",
      sdp: "v=0\r\n",
      codec: "h265",
      source: {
        width: 1170,
        height: 759,
        cursor: { x: 584.5, y: 379 },
        desktopControlVersion: 2,
      },
    }))).toEqual({
      type: "answer",
      sdp: "v=0\r\n",
      codec: "h265",
      source: {
        width: 1170,
        height: 759,
        cursor: { x: 584.5, y: 379 },
        desktopControlVersion: 2,
      },
    });
  });

  it("rejects answers without bounded source metadata", () => {
    expect(() => parseWebrtcTileAnswer(JSON.stringify({ type: "answer", sdp: "v=0\r\n" })))
      .toThrow("WebRTC answer was invalid");
    expect(() => parseWebrtcTileAnswer(JSON.stringify({
      type: "answer",
      sdp: "v=0\r\n",
      codec: "h265",
      source: {
        width: 1170, height: 759, cursor: { x: 1170, y: 10 }, desktopControlVersion: 2,
      },
    }))).toThrow("WebRTC answer was invalid");
  });

  it("rejects an absent or unknown negotiated codec", () => {
    const source = {
      width: 1170, height: 759, cursor: { x: 584.5, y: 379 }, desktopControlVersion: 2,
    };
    expect(() => parseWebrtcTileAnswer(JSON.stringify({
      type: "answer",
      sdp: "v=0\r\n",
      source,
    }))).toThrow("WebRTC answer was invalid");
    expect(() => parseWebrtcTileAnswer(JSON.stringify({
      type: "answer",
      sdp: "v=0\r\n",
      codec: "vp9",
      source,
    }))).toThrow("WebRTC answer was invalid");
  });

  it("keeps video metadata usable when the native helper does not advertise control v2", () => {
    expect(parseWebrtcTileAnswer(JSON.stringify({
      type: "answer",
      sdp: "v=0\r\n",
      codec: "h265",
      source: { width: 1170, height: 759, cursor: { x: 10, y: 10 } },
    })).source.desktopControlVersion).toBe(0);
  });
});
