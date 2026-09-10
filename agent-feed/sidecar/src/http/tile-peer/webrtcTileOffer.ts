// What a viewer's offer body is allowed to say, and the clamp that decides.
//
// Every number here arrives from a browser, so none of it is trusted: `bounded` is the one place
// a client-sent number becomes a number this process will act on, and the telemetry route reads
// its own through the same function for the same reason.

/** An attempt id the viewer minted: a name in a log and a key in a map, never a path. */
export const ATTEMPT_PATTERN = /^[a-zA-Z0-9-]{1,80}$/;

export interface TileOffer {
  displayId?: string;
  attempt?: string;
  /**
   * The attempt this offer takes over from, when the viewer is handing one of its own streams to
   * another. A handover keeps the old peer alive until the new one has painted, so without this
   * the old peer is still subscribed when the new offer arrives, and `encoderDisposition` joins
   * this one to the running capture -- leaving the resolution the viewer asked for unserved.
   */
  supersedes?: string;
  sdp?: string;
  type?: string;
  width?: number;
  height?: number;
  fps?: number;
  bitrate?: number;
  /** A sub-rectangle of the display to capture, in display points. Ignored for window captures. */
  sourceRect?: { x?: number; y?: number; width?: number; height?: number };
}

export function bounded(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return value >= min && value <= max ? Math.round(value) : undefined;
}

/**
 * The offer's crop as the encoder's `--source-rect` argument, or nothing when it is unusable.
 *
 * All four numbers or none: a half-applied crop would capture a region nobody asked for, which
 * looks like a working stream pointed at the wrong part of the desktop. Bounds are the largest
 * display this path supports rather than the actual one, because the encoder clips the rectangle
 * to the real display and says so loudly when they do not overlap -- one owner for that check.
 */
export function encoderSourceRect(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const rect = value as Record<string, unknown>;
  const x = bounded(rect.x, 0, 7680);
  const y = bounded(rect.y, 0, 4320);
  const width = bounded(rect.width, 16, 7680);
  const height = bounded(rect.height, 16, 4320);
  if (x === undefined || y === undefined || width === undefined || height === undefined) {
    return undefined;
  }
  return `${x},${y},${width},${height}`;
}
