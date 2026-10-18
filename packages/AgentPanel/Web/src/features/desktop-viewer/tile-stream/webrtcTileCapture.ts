// How large a capture to ask the sidecar for, given the box the picture is shown in.

// 3, not 2: the phone renders at 3x, and capturing below the display density
// guarantees an upscale that reads as blurry text no matter what the codec
// does. Bits follow pixels via the scale-squared bitrate, so the cost lands
// only where the density exists.
const CAPTURE_PIXEL_RATIO_CAP = 3;

/** The slider's range: a multiplier on the auto-chosen capture scale, capped at source-native. */
export const CAPTURE_SCALE_MIN = 0.5;
export const CAPTURE_SCALE_MAX = 3;

export function tileCaptureSize(
  shownWidth: number,
  sourceWidth: number | undefined,
  sourceHeight: number | undefined,
  devicePixelRatio: number,
  bitrate: number,
  captureScale = 1,
): { width?: number; height?: number; bitrate: number } {
  const ratio = Math.min(devicePixelRatio || 1, CAPTURE_PIXEL_RATIO_CAP);
  // The user's knob multiplies the automatic scale. At 1 it is exactly the display-fit default;
  // above 1 it captures sharper than the picture is shown, up to source-native, so zooming in stays
  // crisp at the cost of bitrate; below 1 it trades sharpness for a thinner stream.
  const quality = Math.min(Math.max(captureScale, CAPTURE_SCALE_MIN), CAPTURE_SCALE_MAX);
  if (
    typeof sourceWidth !== "number" ||
    !Number.isFinite(sourceWidth) ||
    sourceWidth <= 0 ||
    typeof sourceHeight !== "number" ||
    !Number.isFinite(sourceHeight) ||
    sourceHeight <= 0
  ) {
    return {
      width: shownWidth > 0 ? Math.max(16, Math.round(shownWidth * ratio * quality)) : undefined,
      bitrate: Math.max(300_000, Math.round(bitrate * quality * quality)),
    };
  }
  const visibleWidth = shownWidth > 0 ? shownWidth : sourceWidth;
  const scale = Math.min(1, (visibleWidth * ratio * quality) / sourceWidth);
  return {
    width: Math.max(16, Math.round(sourceWidth * scale)),
    height: Math.max(16, Math.round(sourceHeight * scale)),
    bitrate: Math.max(300_000, Math.round(bitrate * scale * scale)),
  };
}
