export type TileVideoCodec = "h265" | "h264";
export type H264EncoderProfile = "high" | "cb";

export interface OfferedVideoCodec {
  mimeType: string;
  parameters?: string;
}

export interface TileVideoCodecChoice<T extends OfferedVideoCodec> {
  kind: TileVideoCodec;
  negotiated: T;
  h264Profile?: H264EncoderProfile;
}

/**
 * Choose a codec the browser actually offered. An active shared encoder wins,
 * because one ScreenCaptureKit capture cannot feed two differently encoded
 * RTP streams without starting the second capture that starves both.
 */
export function chooseTileVideoCodec<T extends OfferedVideoCodec>(
  offered: T[],
  active?: TileVideoCodec,
): TileVideoCodecChoice<T> | undefined {
  const h265 = offered.find((codec) => isSupportedH265(codec));
  const h264 = offered.filter(
    (codec) => codec.mimeType.toLowerCase() === "video/h264" && parameter(codec, "packetization-mode") === "1",
  );
  const high = h264.find((codec) => /^(64|f4)/i.test(parameter(codec, "profile-level-id") ?? ""));

  if (active === "h265") return h265 ? { kind: "h265", negotiated: h265 } : undefined;
  if (active === "h264") {
    const negotiated = high ?? h264[0];
    return negotiated ? { kind: "h264", negotiated, h264Profile: high ? "high" : "cb" } : undefined;
  }
  if (h265) return { kind: "h265", negotiated: h265 };
  const negotiated = high ?? h264[0];
  return negotiated ? { kind: "h264", negotiated, h264Profile: high ? "high" : "cb" } : undefined;
}

function isSupportedH265(codec: OfferedVideoCodec): boolean {
  if (codec.mimeType.toLowerCase() !== "video/h265") return false;
  const txMode = parameter(codec, "tx-mode")?.toUpperCase() ?? "SRST";
  const maxDonDiff = Number(parameter(codec, "sprop-max-don-diff") ?? "0");
  return txMode === "SRST" && maxDonDiff === 0;
}

function parameter(codec: OfferedVideoCodec, name: string): string | undefined {
  for (const entry of codec.parameters?.split(";") ?? []) {
    const [key, ...value] = entry.trim().split("=");
    if (key?.toLowerCase() === name) return value.join("=").trim();
  }
  return undefined;
}
