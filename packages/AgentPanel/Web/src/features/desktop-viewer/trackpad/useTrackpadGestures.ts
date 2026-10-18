// What one finger on the trackpad pad means: the Swift client's trackpad, recognizer by recognizer.
//
// `GestureTranslator.attach` put four recognizers on its pad: a coalescing pan that moves the
// pointer after 3pt of travel, a tap that clicks, a 250ms long press that holds the button, and a
// three-finger swipe up (left out here, on the owner's word). A browser has no recognizers, so
// this is the arbitration they did between them, written out: a finger that travels before the
// hold is a move, one that lifts before it is a click, one that stays is a held button.

import { useEffect, type RefObject } from "react";
import { TOUCH_DRAG_HOLD_MS } from "@/features/desktop-viewer/pointer-input/gestureConstants";
import type { PointerInputSession } from "@/features/desktop-viewer/pointer-input/pointerInputSession";
import { useLatestRef } from "@/hooks/useLatestRef";

export interface TrackpadGestureOptions {
  input: PointerInputSession;
  /** Runs inside the tap, before its click goes out; returns a focus request id, if any. */
  beforeClick?: () => string | undefined;
  /** The pad's held state changed, for drawing it. */
  onHeld?: (held: boolean) => void;
  /** The wheel over the pad, which on a Mac trackpad is its own two-finger scroll. */
  onWheel?: (event: WheelEvent) => void;
}

export function useTrackpadGestures(pad: RefObject<HTMLElement | null>, options: TrackpadGestureOptions) {
  const latest = useLatestRef(options);

  useEffect(() => {
    const element = pad.current;
    if (!element) return undefined;
    const fingers = new Set<number>();
    let primary: number | null = null;
    let moved = false;
    let superseded = false;
    let holdTimer = 0;

    const translator = () => latest.current.input.translator;
    const local = (event: PointerEvent) => {
      const box = element.getBoundingClientRect();
      return { x: event.clientX - box.left, y: event.clientY - box.top };
    };
    const cancelHold = () => {
      if (holdTimer !== 0) window.clearTimeout(holdTimer);
      holdTimer = 0;
    };
    const release = () => {
      cancelHold();
      const dropped = translator().dragEnd();
      if (dropped) latest.current.onHeld?.(false);
      return dropped;
    };

    const down = (event: PointerEvent) => {
      event.preventDefault();
      try {
        element.setPointerCapture(event.pointerId);
      } catch {
        // Losing capture only ends the gesture at the pad's edge.
      }
      fingers.add(event.pointerId);
      if (fingers.size > 1) {
        // The Swift pad's pan took one finger only. A second one ends whatever the first was
        // doing, including a held button, rather than becoming something of its own.
        superseded = true;
        cancelHold();
        translator().cursorCancel();
        release();
        return;
      }
      primary = event.pointerId;
      moved = false;
      superseded = false;
      const at = local(event);
      translator().cursorBegin(at);
      holdTimer = window.setTimeout(() => {
        holdTimer = 0;
        if (moved || superseded || primary === null) return;
        translator().cursorCancel();
        if (translator().dragBegin(at)) latest.current.onHeld?.(true);
      }, TOUCH_DRAG_HOLD_MS);
    };

    const move = (event: PointerEvent) => {
      if (event.pointerId !== primary || superseded) return;
      const coalesced = event.getCoalescedEvents?.() ?? [];
      const samples = (coalesced.length > 0 ? coalesced : [event]).map(local);
      if (translator().isDragging) {
        translator().dragMove(samples.at(-1)!, { width: element.clientWidth, height: element.clientHeight });
        return;
      }
      if (translator().cursorSamples(samples) && !moved) {
        moved = true;
        cancelHold();
      }
    };

    const finish = (event: PointerEvent, cancelled: boolean) => {
      fingers.delete(event.pointerId);
      if (event.pointerId !== primary) return;
      primary = null;
      cancelHold();
      if (cancelled || superseded) {
        translator().cursorCancel();
        release();
        return;
      }
      translator().cursorEnd();
      const dropped = release();
      if (!dropped && !moved) translator().tap("left", latest.current.beforeClick?.());
    };
    const up = (event: PointerEvent) => finish(event, false);
    const cancel = (event: PointerEvent) => finish(event, true);
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
      cancelHold();
      // A button held from the pad must not outlive the pad.
      if (translator().dragEnd()) latest.current.onHeld?.(false);
      translator().cursorCancel();
    };
  }, [pad]);
}
