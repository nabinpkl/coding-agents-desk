// What a finger on the scroll strip means: the Swift client's right-edge strip.
//
// The strip starts on touch-down with no slop (`InstantPanGestureRecognizer`), so the first inch
// of travel is the first inch of scroll. It is a clutch: the finger has to land on the strip, but
// pointer capture keeps the gesture its own wherever the finger goes after that. It commits to
// one axis once the finger has travelled far enough to say which, and a lift that was a throw
// coasts. All of that past the touch itself is the shared translator's.

import { useEffect, useRef, type RefObject } from "react";
import type { PointerInputSession } from "@/features/desktop-viewer/pointer-input/pointerInputSession";
import { VelocityTracker } from "@/features/desktop-viewer/pointer-input/velocityTracker";

export function useScrollStripGestures(
  strip: RefObject<HTMLElement | null>,
  options: { input: PointerInputSession; onWheel?: (event: WheelEvent) => void },
) {
  const latest = useRef(options);
  latest.current = options;

  useEffect(() => {
    const element = strip.current;
    if (!element) return undefined;
    const velocity = new VelocityTracker();
    let finger: number | null = null;
    let start = { x: 0, y: 0 };

    const scroll = () => latest.current.input.translator.scroll;
    const sampledAt = (event: Event) =>
      Number.isFinite(event.timeStamp) && event.timeStamp > 0 ? event.timeStamp : performance.now();

    const down = (event: PointerEvent) => {
      event.preventDefault();
      if (finger !== null) return;
      try {
        element.setPointerCapture(event.pointerId);
      } catch {
        // Without capture the strip still scrolls; it just loses the finger past its edge.
      }
      finger = event.pointerId;
      start = { x: event.clientX, y: event.clientY };
      velocity.reset();
      velocity.add(event.clientX, event.clientY, sampledAt(event));
      // Touching stops a coast, as on a Mac trackpad, and begins the gesture at once.
      scroll().begin({ x: 0, y: 0 }, "dominant-axis");
    };
    const move = (event: PointerEvent) => {
      if (event.pointerId !== finger) return;
      const coalesced = event.getCoalescedEvents?.() ?? [];
      for (const sample of coalesced.length > 0 ? coalesced : [event]) {
        velocity.add(sample.clientX, sample.clientY, sampledAt(sample));
      }
      scroll().change({ x: event.clientX - start.x, y: event.clientY - start.y }, velocity.velocity());
    };
    const up = (event: PointerEvent) => {
      if (event.pointerId !== finger) return;
      finger = null;
      scroll().end(velocity.velocity());
    };
    const cancel = (event: PointerEvent) => {
      if (event.pointerId !== finger) return;
      finger = null;
      scroll().cancel();
    };
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      latest.current.onWheel?.(event);
    };

    element.addEventListener("pointerdown", down);
    element.addEventListener("pointermove", move);
    element.addEventListener("pointerup", up);
    element.addEventListener("pointercancel", cancel);
    element.addEventListener("wheel", wheel, { passive: false });
    return () => {
      element.removeEventListener("pointerdown", down);
      element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerup", up);
      element.removeEventListener("pointercancel", cancel);
      element.removeEventListener("wheel", wheel);
      if (finger !== null) scroll().cancel();
    };
  }, [strip]);
}
