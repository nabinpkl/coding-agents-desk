// Zooming and panning one picture, for the lightbox.
//
// Split from the dialog because it is arithmetic with two input paths in it -- a wheel and a
// cursor on the Mac, two fingers on the phone -- and none of that is about how the dialog looks.
//
// The rule every gesture here obeys: whatever is under the cursor or between the fingers stays
// under them. Zooming about the centre instead is what makes a reader chase the detail they were
// already pointing at.

import { useCallback, useRef, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { useLatestRef } from "@/hooks/useLatestRef";
import { useEventListener } from "@/hooks/dom/useEventListener";
import { useLeaveEffect } from "@/hooks/useMountEffect";
import { useStateFor } from "@/hooks/state/useStateFor";

/** Fit is the floor: this view exists to show the whole picture first. */
export const FIT_SCALE = 1;
export const MAX_SCALE = 8;
/** One press of a button. A square-root-of-two step reaches 8x in six presses. */
const BUTTON_STEP = Math.SQRT2;
/** Double click, and double tap, go straight to a reading size rather than stepping there. */
const DOUBLE_CLICK_SCALE = 2.5;

interface View {
  scale: number;
  /** Pixels the picture is shifted from centred, at the CURRENT scale. */
  x: number;
  y: number;
}

const FIT: View = { scale: FIT_SCALE, x: 0, y: 0 };

function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(FIT_SCALE, scale));
}

function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export interface ImageZoom {
  scale: number;
  isFit: boolean;
  canZoomIn: boolean;
  zoomIn: () => void;
  zoomOut: () => void;
  reset: () => void;
  /** True while a finger or a held button is moving the picture. */
  isMoving: boolean;
  frameRef: (node: HTMLDivElement | null) => void;
  imageRef: (node: HTMLImageElement | null) => void;
  frameHandlers: {
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
    onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
    onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
    onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void;
    onDoubleClick: (event: ReactMouseEvent<HTMLElement>) => void;
  };
  transform: string;
}

/**
 * @param resetKey Changing it returns the view to fit: a second picture opens whole, never
 *                 inside the last one's magnification.
 */
export function useImageZoom(resetKey: string): ImageZoom {
  const frame = useRef<HTMLDivElement | null>(null);
  const image = useRef<HTMLImageElement | null>(null);
  // A second picture opens whole, never at the zoom and pan the first was left in.
  const [view, setView] = useStateFor<View>(resetKey, () => FIT);
  // Gestures read the view they are continuing, and a pointer move must not wait for a render to
  // see where the last one left it.
  const latest = useLatestRef<View>(view);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ distance: number; scale: number } | null>(null);
  const drag = useRef<{ x: number; y: number; from: View } | null>(null);
  const [isMoving, setMoving] = useStateFor(resetKey, () => false);

  /**
   * How large the picture is actually painted at scale 1. Not the element's box: `object-contain`
   * letterboxes inside it, and panning the letterbox is panning nothing.
   */
  const paintedSize = useCallback((): { width: number; height: number } | null => {
    const node = image.current;
    if (!node) return null;
    const boxWidth = node.offsetWidth;
    const boxHeight = node.offsetHeight;
    const { naturalWidth, naturalHeight } = node;
    if (!boxWidth || !boxHeight) return null;
    if (!naturalWidth || !naturalHeight) return { width: boxWidth, height: boxHeight };
    const fit = Math.min(boxWidth / naturalWidth, boxHeight / naturalHeight);
    return { width: naturalWidth * fit, height: naturalHeight * fit };
  }, []);

  /** No dragging the picture off its own frame: the pan stops where the overflow does. */
  const clamp = useCallback(
    (next: View): View => {
      const box = frame.current;
      const size = paintedSize();
      if (!box || !size) return { ...next, x: 0, y: 0 };
      const maxX = Math.max(0, (size.width * next.scale - box.clientWidth) / 2);
      const maxY = Math.max(0, (size.height * next.scale - box.clientHeight) / 2);
      return {
        scale: next.scale,
        x: Math.min(maxX, Math.max(-maxX, next.x)),
        y: Math.min(maxY, Math.max(-maxY, next.y)),
      };
    },
    [paintedSize],
  );

  /**
   * Zoom to `resolve(current)`, holding the point at (clientX, clientY) still. With no point it
   * holds the middle, which is what a button press means.
   */
  const zoomTo = useCallback(
    (resolve: (scale: number) => number, clientX?: number, clientY?: number) => {
      setView((current) => {
        const scale = clampScale(resolve(current.scale));
        const box = frame.current;
        if (!box || scale === current.scale) return clamp({ ...current, scale });
        const rect = box.getBoundingClientRect();
        const centreX = rect.left + rect.width / 2;
        const centreY = rect.top + rect.height / 2;
        const pointX = (clientX ?? centreX) - centreX;
        const pointY = (clientY ?? centreY) - centreY;
        const ratio = scale / current.scale;
        return clamp({
          scale,
          x: pointX - (pointX - current.x) * ratio,
          y: pointY - (pointY - current.y) * ratio,
        });
      });
    },
    [clamp, setView],
  );

  // A wheel over the picture zooms rather than scrolling, so the listener has to be able to
  // preventDefault -- which React's own onWheel, attached passively at the root, cannot do.
  // A trackpad pinch arrives here too, as a wheel with ctrlKey set and a much larger delta.
  useEventListener<WheelEvent>(
    frame,
    "wheel",
    (event) => {
      const box = frame.current;
      if (!box) return;
      event.preventDefault();
      // Wheels do not all speak pixels: a line-mode wheel reports about 3, a page-mode one about
      // 1, and reading either as pixels makes the wheel do nothing at all.
      const lines = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? box.clientHeight : 1;
      // A notch is about 100 pixels, so this is roughly 1.2x per notch. A trackpad pinch arrives
      // as a ctrl-wheel of much smaller deltas, which is why it gets its own rate.
      const rate = event.ctrlKey ? 0.01 : 0.002;
      zoomTo((scale) => scale * Math.exp(-event.deltaY * lines * rate), event.clientX, event.clientY);
    },
    { passive: false },
  );

  // A picture is only as big as the window it is in: shrinking the window can leave the view
  // panned past an edge that just moved.
  useEventListener(window, "resize", () => setView((current) => clamp(current)));

  // A gesture in progress belongs to the picture it started on.
  useLeaveEffect(resetKey, () => {
    pointers.current.clear();
    pinch.current = null;
    drag.current = null;
  });

  const endGesture = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      pointers.current.delete(event.pointerId);
      const left = [...pointers.current.entries()];
      if (left.length < 2) pinch.current = null;
      // Lifting one finger of a pinch leaves the other one on the picture, and it should carry on
      // moving it rather than waiting to be lifted and put down again.
      if (left.length === 1 && latest.current.scale > FIT_SCALE) {
        drag.current = { x: left[0]![1].x, y: left[0]![1].y, from: latest.current };
        return;
      }
      if (left.length === 0) {
        drag.current = null;
        setMoving(false);
      }
    },
    [latest, setMoving],
  );

  const frameHandlers = {
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
      pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      // Capture so a fast drag that leaves the frame keeps arriving here rather than stopping
      // dead over whatever it crossed.
      event.currentTarget.setPointerCapture?.(event.pointerId);
      const touching = [...pointers.current.values()];
      if (touching.length === 2) {
        pinch.current = { distance: distance(touching[0]!, touching[1]!), scale: latest.current.scale };
        drag.current = null;
        // Same flag as a drag: while a gesture is moving the picture it follows the fingers
        // exactly, with no transition smoothing a frame behind them.
        setMoving(true);
        return;
      }
      if (latest.current.scale > FIT_SCALE) {
        drag.current = { x: event.clientX, y: event.clientY, from: latest.current };
        setMoving(true);
      }
    },
    onPointerMove: (event: ReactPointerEvent<HTMLElement>) => {
      if (!pointers.current.has(event.pointerId)) return;
      pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const touching = [...pointers.current.values()];
      const started = pinch.current;
      if (started && touching.length === 2) {
        const spread = distance(touching[0]!, touching[1]!);
        if (started.distance > 0) {
          zoomTo(
            () => started.scale * (spread / started.distance),
            (touching[0]!.x + touching[1]!.x) / 2,
            (touching[0]!.y + touching[1]!.y) / 2,
          );
        }
        return;
      }
      const held = drag.current;
      if (!held) return;
      setView(
        clamp({
          scale: held.from.scale,
          x: held.from.x + (event.clientX - held.x),
          y: held.from.y + (event.clientY - held.y),
        }),
      );
    },
    onPointerUp: endGesture,
    onPointerCancel: endGesture,
    onDoubleClick: (event: ReactMouseEvent<HTMLElement>) => {
      zoomTo((scale) => (scale > FIT_SCALE ? FIT_SCALE : DOUBLE_CLICK_SCALE), event.clientX, event.clientY);
    },
  };

  return {
    scale: view.scale,
    isFit: view.scale <= FIT_SCALE,
    canZoomIn: view.scale < MAX_SCALE,
    zoomIn: () => zoomTo((scale) => scale * BUTTON_STEP),
    zoomOut: () => zoomTo((scale) => scale / BUTTON_STEP),
    reset: () => setView(FIT),
    isMoving,
    frameRef: (node) => {
      frame.current = node;
    },
    imageRef: (node) => {
      image.current = node;
    },
    frameHandlers,
    transform: `translate3d(${view.x}px, ${view.y}px, 0) scale(${view.scale})`,
  };
}
