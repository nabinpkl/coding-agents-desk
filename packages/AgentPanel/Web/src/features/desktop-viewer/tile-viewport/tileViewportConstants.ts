// The numbers the viewport itself is tuned against, and where the puck's resting place is
// remembered.
//
// Each is a measurement about a frame or a mark on the picture, which is why they are named
// rather than inline. What a finger means to the Mac -- slop, curves, the coast, the hold -- is
// tuned against the iPhone client and lives in `pointer-input/gestureConstants.ts`.

export const CURSOR_MIRROR_RENDER_SCALE = 0.7;
/** How long after the last zoom or pan before the capture is re-aimed. DeskZoom's settle delay. */
export const VIEW_SETTLE_MS = 150;
/** Shortest gap between two re-aims; each one swaps the picture while the new stream negotiates. */
export const VIEW_REAIM_INTERVAL_MS = 350;
/**
 * How long a finger rests before the priming ring appears at all.
 *
 * Drawing it on touch-down would put a ring under every tap, and almost every tap is a click. The
 * ring waits out the length of an ordinary tap and then shows the progress already made, so it
 * only ever appears for someone who is holding on purpose.
 */
export const DRAG_PRIMING_DELAY_MS = 150;
export const DRAG_PRIMING_RADIUS = 12;
export const DRAG_PRIMING_CIRCUMFERENCE = 2 * Math.PI * DRAG_PRIMING_RADIUS;
/**
 * How long the wheel has to be quiet before the remote scroll is ended.
 *
 * Long enough that neither a notched wheel between clicks nor a trackpad's own momentum stream
 * (both under ~60ms apart in Chrome on macOS) reads as a stop, short enough that the far Mac is
 * not left inside an open scroll phase after the hand is off.
 */
export const WHEEL_SCROLL_IDLE_MS = 150;
export const POINTER_SCROLL_PUCK_SIDE = 56;
export const POINTER_SCROLL_PUCK_STORAGE_KEY = "agentdesk.pointer-scroll-puck-offset.v1";
export const DEFAULT_POINTER_SCROLL_PUCK_OFFSET = { right: 16, bottom: 120 };

export interface PointerScrollPuckOffset {
  right: number;
  bottom: number;
}

export function storedPointerScrollPuckOffset(): PointerScrollPuckOffset {
  try {
    const stored = window.localStorage.getItem(POINTER_SCROLL_PUCK_STORAGE_KEY);
    if (!stored) return DEFAULT_POINTER_SCROLL_PUCK_OFFSET;
    const parsed = JSON.parse(stored) as Partial<PointerScrollPuckOffset>;
    if (
      typeof parsed.right !== "number" ||
      !Number.isFinite(parsed.right) ||
      typeof parsed.bottom !== "number" ||
      !Number.isFinite(parsed.bottom)
    ) {
      return DEFAULT_POINTER_SCROLL_PUCK_OFFSET;
    }
    return { right: parsed.right, bottom: parsed.bottom };
  } catch {
    return DEFAULT_POINTER_SCROLL_PUCK_OFFSET;
  }
}
