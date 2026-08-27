import type { WebrtcTileSourceMetadata } from "@agentdesk/agent-feed-wire";

const MAX_SOURCE_EXTENT = 100_000;

function finite(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

/** Validates the native helper's opening frame before it crosses into the WebView. */
export function gridEncoderSourceMetadata(value: unknown): WebrtcTileSourceMetadata | null {
  if (typeof value !== "object" || value === null) return null;
  const meta = value as Record<string, unknown>;
  if (meta.type !== "open") return null;

  const inputBounds = meta.inputBounds;
  const cursor = meta.cursor;
  if (
    typeof inputBounds !== "object"
    || inputBounds === null
    || typeof cursor !== "object"
    || cursor === null
  ) return null;

  const bounds = inputBounds as Record<string, unknown>;
  const position = cursor as Record<string, unknown>;
  if (
    !finite(bounds.w, 1, MAX_SOURCE_EXTENT)
    || !finite(bounds.h, 1, MAX_SOURCE_EXTENT)
    || !finite(position.x, 0, bounds.w)
    || !finite(position.y, 0, bounds.h)
    || position.x >= bounds.w
    || position.y >= bounds.h
    || meta.desktopControlVersion !== 2
  ) return null;

  return {
    width: bounds.w,
    height: bounds.h,
    cursor: { x: position.x, y: position.y },
    desktopControlVersion: 2,
  };
}
