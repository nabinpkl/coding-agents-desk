import { describe, expect, test } from "bun:test";
import { chooseTileVideoCodec } from "@/http/tile/tile-codec/webrtcTileCodec";

const h265 = { mimeType: "video/H265", parameters: "tx-mode=SRST;sprop-max-don-diff=0" };
const baseline = {
  mimeType: "video/H264",
  parameters: "packetization-mode=1;profile-level-id=42e01f",
};
const high = {
  mimeType: "video/H264",
  parameters: "profile-level-id=640c1f;packetization-mode=1",
};

describe("chooseTileVideoCodec", () => {
  test("prefers HEVC when the first-party WebView offers it", () => {
    expect(chooseTileVideoCodec([baseline, h265, high])).toEqual({
      kind: "h265",
      negotiated: h265,
    });
  });

  test("accepts omitted HEVC parameters because RFC 7798 defaults to SRST and DON diff zero", () => {
    const defaultH265 = { mimeType: "video/H265" };
    expect(chooseTileVideoCodec([defaultH265])?.kind).toBe("h265");
  });

  test("rejects HEVC modes that require unsupported DON or multiple streams", () => {
    expect(chooseTileVideoCodec([
      { mimeType: "video/H265", parameters: "sprop-max-don-diff=4" },
      { mimeType: "video/H265", parameters: "tx-mode=MRST" },
      baseline,
    ])).toEqual({ kind: "h264", negotiated: baseline, h264Profile: "cb" });
  });

  test("preserves the active shared encoder codec instead of starting another capture", () => {
    expect(chooseTileVideoCodec([h265, high], "h264")).toEqual({
      kind: "h264",
      negotiated: high,
      h264Profile: "high",
    });
    expect(chooseTileVideoCodec([h265, high], "h265")).toEqual({
      kind: "h265",
      negotiated: h265,
    });
  });

  test("returns no choice when the browser cannot consume the active codec", () => {
    expect(chooseTileVideoCodec([baseline], "h265")).toBeUndefined();
    expect(chooseTileVideoCodec([h265], "h264")).toBeUndefined();
  });

  test("prefers H.264 High over Baseline when HEVC is absent", () => {
    expect(chooseTileVideoCodec([baseline, high])).toEqual({
      kind: "h264",
      negotiated: high,
      h264Profile: "high",
    });
  });
});
