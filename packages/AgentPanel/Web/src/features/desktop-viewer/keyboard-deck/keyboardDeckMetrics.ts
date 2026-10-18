/**
 * The keyboard deck's measurements, ported verbatim from `KeyboardDeckMetrics.swift` and
 * `KeyboardCharacterPreview.swift`. These numbers are the reason the deck reads as the iPhone
 * keyboard rather than as a grid of buttons, so they are copied rather than re-derived.
 */

export interface KeyboardDeckMetrics {
  keycapHeight: number;
  verticalRowGap: number;
  horizontalKeyGap: number;
  horizontalDeckInset: number;
  topDeckPadding: number;
  bottomDeckPadding: number;
  /** The wider gap either side of the alphabet row's shift and delete keys. */
  alphabetOuterKeyGap: number;
  deckHeight: number;
}

export const PORTRAIT_DECK: KeyboardDeckMetrics = {
  keycapHeight: 46,
  verticalRowGap: 10,
  horizontalKeyGap: 6,
  horizontalDeckInset: 7,
  topDeckPadding: 14,
  bottomDeckPadding: 8,
  alphabetOuterKeyGap: 10,
  deckHeight: 236,
};

export const COMPACT_LANDSCAPE_DECK: KeyboardDeckMetrics = {
  keycapHeight: 44,
  verticalRowGap: 5,
  horizontalKeyGap: 4,
  horizontalDeckInset: 7,
  topDeckPadding: 6,
  bottomDeckPadding: 4,
  alphabetOuterKeyGap: 8,
  deckHeight: 201,
};

/**
 * iOS picks between these two on the vertical size class. A page has no size class, and the thing
 * the size class is standing in for is simply how little height there is to spend.
 */
export const COMPACT_DECK_MAX_VIEWPORT_HEIGHT = 500;

export function deckMetricsForViewportHeight(height: number): KeyboardDeckMetrics {
  return height < COMPACT_DECK_MAX_VIEWPORT_HEIGHT ? COMPACT_LANDSCAPE_DECK : PORTRAIT_DECK;
}

/**
 * How far past a key's edge the finger may stray before the press is abandoned.
 *
 * UIKit gives this away free: `UIControl` keeps tracking well outside its own bounds before it
 * fires `touchDragExit`, so an ordinary thumb tap that rolls a few points still counts. Testing
 * the exact rectangle instead means a tap landing near an edge types nothing at all, which is
 * exactly what fast typing feels like when it drops characters. Twice the gap leaves the seam
 * between two keys belonging to both, while staying well short of a neighbour's centre.
 */
export function keyExitSlop(metrics: KeyboardDeckMetrics): { x: number; y: number } {
  return { x: metrics.horizontalKeyGap * 2, y: metrics.verticalRowGap * 2 };
}

export const CHARACTER_PREVIEW = {
  horizontalMargin: 3,
  minimumWidth: 60,
  maximumWidth: 72,
  bubbleHeight: 58,
  tailHeight: 9,
  /** How far the bubble's tail reaches down over the key it belongs to. */
  keyOverlap: 3,
  tailHalfWidth: 8,
  cornerRadius: 11,
} as const;

export interface CharacterPreviewLayout {
  left: number;
  top: number;
  width: number;
  height: number;
  /** The tail's tip, in the bubble's own coordinates. */
  tipX: number;
}

/**
 * Place the balloon above a key, in the deck's coordinates.
 *
 * The bubble stops a fixed margin from the deck's edges, so an edge key's balloon cannot be
 * centred on it. The tail is what moves instead: it is clamped to stay on the bubble's flat
 * bottom, between the two corner radii, so it still points at the key without detaching.
 */
export function characterPreviewLayout(
  key: { left: number; top: number; width: number },
  containerWidth: number,
): CharacterPreviewLayout {
  const {
    horizontalMargin,
    minimumWidth,
    maximumWidth,
    bubbleHeight,
    tailHeight,
    keyOverlap,
    tailHalfWidth,
    cornerRadius,
  } = CHARACTER_PREVIEW;
  const availableWidth = Math.max(0, containerWidth - horizontalMargin * 2);
  const preferredWidth = Math.min(maximumWidth, Math.max(minimumWidth, key.width + 16));
  const width = Math.min(preferredWidth, availableWidth);
  const height = bubbleHeight + tailHeight;
  const keyMidX = key.left + key.width / 2;
  const maximumX = Math.max(horizontalMargin, containerWidth - horizontalMargin - width);
  const left = Math.min(Math.max(keyMidX - width / 2, horizontalMargin), maximumX);
  const minimumTipX = cornerRadius + tailHalfWidth;
  const maximumTipX = Math.max(minimumTipX, width - cornerRadius - tailHalfWidth);
  const tipX = Math.min(Math.max(keyMidX - left, minimumTipX), maximumTipX);
  return { left, top: key.top - height + keyOverlap, width, height, tipX };
}

/**
 * The balloon outline as an SVG path: a rounded rectangle whose bottom edge is interrupted by a
 * triangular tail. The tail is off-centre for edge keys, which is why this is a path rather than a
 * border radius with a rotated square underneath it.
 */
export function characterPreviewPath(width: number, height: number, tipX: number): string {
  const { bubbleHeight, tailHalfWidth, cornerRadius } = CHARACTER_PREVIEW;
  const radius = Math.min(cornerRadius, Math.min(width, bubbleHeight) / 2);
  return [
    `M ${radius} 0`,
    `L ${width - radius} 0`,
    `Q ${width} 0 ${width} ${radius}`,
    `L ${width} ${bubbleHeight - radius}`,
    `Q ${width} ${bubbleHeight} ${width - radius} ${bubbleHeight}`,
    `L ${tipX + tailHalfWidth} ${bubbleHeight}`,
    `L ${tipX} ${height}`,
    `L ${tipX - tailHalfWidth} ${bubbleHeight}`,
    `L ${radius} ${bubbleHeight}`,
    `Q 0 ${bubbleHeight} 0 ${bubbleHeight - radius}`,
    `L 0 ${radius}`,
    `Q 0 0 ${radius} 0`,
    "Z",
  ].join(" ");
}
