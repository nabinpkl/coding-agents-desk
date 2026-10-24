// Pressing a card to carry it along the strip: a mouse carries once it has moved, a finger once it
// has held still.
//
// The two input paths split here, and only here, because a finger on this canvas already means
// something by a sideways move: scrolling the strip. So a finger says it means to carry by holding
// still for as long as an iOS long press (250ms, `UILongPressGestureRecognizer`'s default, and the
// hold the desktop viewer's touch drag uses), and a finger that moves first is a scroll and is left
// to the browser. A mouse has no scroll to compete with, so it carries once it has moved a few
// pixels, which keeps a click a click.
//
// Once a finger is carrying, the page must not scroll under it. The browser has not started a pan
// (the finger was still), and a touchmove whose default is prevented never becomes one. That
// listener is registered for as long as the element exists rather than when the hold fires: a
// browser decides when a touch starts whether its moves can be cancelled at all, from the listeners
// present then. It does nothing unless a finger is carrying.

import { useRef, useState } from "react";
import { useEventListener } from "@/hooks/dom/useEventListener";
import { useUnmountEffect } from "@/hooks/useMountEffect";

/** How far a mouse moves before a press stops being a click and becomes a carry. */
const MOVE_THRESHOLD = 4;
/** How long a finger holds still before it picks the card up. */
export const CARRY_HOLD_MS = 250;
/** How far a finger may wander while holding and still count as holding rather than scrolling. */
const HOLD_TOLERANCE = 8;

interface Press {
  pointerId: number;
  touch: boolean;
  startX: number;
  startY: number;
  carrying: boolean;
}

export interface CarryGesture<E extends HTMLElement> {
  /** The element pressed, as a callback ref: the touch listener goes on it once it is there. */
  attach: (node: E | null) => void;
  handlers: {
    onPointerDown: (event: React.PointerEvent<E>) => void;
    onPointerMove: (event: React.PointerEvent<E>) => void;
    onPointerUp: (event: React.PointerEvent<E>) => void;
    onPointerCancel: (event: React.PointerEvent<E>) => void;
    onContextMenu: (event: React.MouseEvent<E>) => void;
  };
  /** Whether the last press became a carry, so the click it ends in does not also act. */
  carried: () => boolean;
}

export function useCarryGesture<E extends HTMLElement>({
  onStart,
  onMove,
  onEnd,
  ignore,
}: {
  onStart: (clientX: number) => void;
  onMove: (clientX: number) => void;
  onEnd: () => void;
  /** A press that starts on this is not a carry: a control inside the handle keeps its press. */
  ignore?: (target: Element) => boolean;
}): CarryGesture<E> {
  const [element, attach] = useState<E | null>(null);
  const press = useRef<Press | null>(null);
  const hold = useRef<number | null>(null);
  const carried = useRef(false);
  const latestX = useRef(0);

  const clearHold = (): void => {
    if (hold.current !== null) window.clearTimeout(hold.current);
    hold.current = null;
  };

  const lift = (held: Press): void => {
    held.carrying = true;
    carried.current = true;
    onStart(held.startX);
  };

  useEventListener<TouchEvent>(
    element,
    "touchmove",
    (event) => {
      if (press.current?.touch && press.current.carrying) event.preventDefault();
    },
    { passive: false },
  );
  useUnmountEffect(clearHold);

  const release = (event: React.PointerEvent<E>): void => {
    const held = press.current;
    if (!held || held.pointerId !== event.pointerId) return;
    clearHold();
    press.current = null;
    if (held.carrying) onEnd();
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };

  return {
    attach,
    carried: () => carried.current,
    handlers: {
      onPointerDown: (event) => {
        if (ignore?.(event.target as Element)) return;
        // Cleared on the way IN rather than after a carry, so a drag that ended somewhere else does
        // not leave a flag behind to swallow the next tap.
        carried.current = false;
        clearHold();
        const held: Press = {
          pointerId: event.pointerId,
          touch: event.pointerType === "touch",
          startX: event.clientX,
          startY: event.clientY,
          carrying: false,
        };
        press.current = held;
        latestX.current = event.clientX;
        event.currentTarget.setPointerCapture?.(event.pointerId);
        if (!held.touch) return;
        hold.current = window.setTimeout(() => {
          hold.current = null;
          if (press.current !== held) return;
          lift(held);
          // Where the finger is now, which may be a few pixels from where it landed.
          onMove(latestX.current);
        }, CARRY_HOLD_MS);
      },
      onPointerMove: (event) => {
        const held = press.current;
        if (!held || held.pointerId !== event.pointerId) return;
        latestX.current = event.clientX;
        if (!held.carrying) {
          if (held.touch) {
            // Moved before the hold: a scroll, which is the browser's, so this press is over.
            if (Math.hypot(event.clientX - held.startX, event.clientY - held.startY) > HOLD_TOLERANCE) {
              clearHold();
              press.current = null;
            }
            return;
          }
          if (Math.abs(event.clientX - held.startX) < MOVE_THRESHOLD) return;
          lift(held);
        }
        onMove(event.clientX);
      },
      onPointerUp: release,
      onPointerCancel: release,
      // A held finger is a long press to the browser too, which would answer with its own menu.
      onContextMenu: (event) => {
        if (press.current?.touch) event.preventDefault();
      },
    },
  };
}
