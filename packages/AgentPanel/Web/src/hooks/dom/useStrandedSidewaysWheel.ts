// A sideways swipe the browser gave to a scroller inside this one moves this one instead.
//
// Chrome gives each wheel swipe to one scroller, picked when it starts: the first one under the
// pointer that can use any of the movement. It keeps the swipe there until the fingers lift and the
// glide ends, and never passes it on partway. So on a strip of cards that each scroll up and down,
// a sideways swipe carrying even a pixel of up-or-down drift the card can use goes to the card under
// the pointer. It cannot use the sideways part, and the strip stands still for that whole swipe. Measured
// 2026-10-24 on the Bot canvas: wheels of 40 across and 1 up over a transcript moved the canvas 0.
//
// Cancelling the browser's scroll is not available. Once the first wheel of a touchpad swipe goes
// through uncancelled, Chrome sends the rest of that swipe as events that cannot be cancelled, and
// cancelling every first wheel to keep hold would make every up-and-down scroll of a transcript wait
// on this page's script. So this only watches, through a passive listener. When sideways movement
// keeps arriving and nothing moves sideways in answer, neither this scroller nor anything between
// it and the pointer, the swipe is stranded. This then moves the scroller by the swipe's sideways
// part for the rest of it, glide included. The moment the scroller moves without this having moved
// it, the browser is scrolling it, and this stands down, so no swipe is applied twice.
//
// A swipe that scrolls something sideways inside, such as a wide code block, stays that scroller's
// to its end, as the browser has it: carrying on into the strip when the block runs out would throw
// the reader off the card they were reading.

import { useState } from "react";
import { useEventListener } from "@/hooks/dom/useEventListener";

/** A wheel this long after the last one starts a new swipe. A swipe and its glide send one a frame. */
const SWIPE_GAP_MS = 150;
/** Sideways wheels in a row that moved nothing before a swipe counts as stranded. Two, because the
 *  browser's own scroll of this element can land a frame after the wheel that asked for it. */
const STRANDED_WHEELS = 2;
/** And the least they asked to move, so a twitch at the start of an up-and-down scroll is not one. */
const STRANDED_PX = 6;
/** Less than this is the same position: scroll offsets are fractional. */
const SAME = 0.5;
/** A line-mode wheel's line, as the canvas zoom reads it. */
const LINE_PX = 16;

interface Watch {
  /** The scroller's offset after the last wheel this handled, its own move included. */
  left: number;
  /** What between the pointer and the scroller can scroll sideways, and where each stood. */
  target: EventTarget | null;
  inside: HTMLElement[];
  insideLefts: number[];
}

interface Swipe {
  last: number;
  watch: Watch | null;
  /** Sideways wheels in a row, and their pixels, that moved nothing. */
  still: number;
  stillPx: number;
  /** This is moving the scroller for the swipe. */
  moving: boolean;
  /** Something inside scrolled sideways with the swipe, so the rest of it is that scroller's. */
  insideOwns: boolean;
}

function pixels(delta: number, mode: number, page: number): number {
  return mode === 1 ? delta * LINE_PX : mode === 2 ? delta * page : delta;
}

/** The sideways scrollers from the wheel's target up to, and not including, the scroller. */
function sidewaysScrollersInside(target: EventTarget | null, scroller: HTMLElement): HTMLElement[] {
  const found: HTMLElement[] = [];
  let node = target instanceof Element ? target : null;
  while (node && node !== scroller) {
    if (node instanceof HTMLElement && node.scrollWidth > node.clientWidth) {
      const overflow = getComputedStyle(node).overflowX;
      if (overflow === "auto" || overflow === "scroll") found.push(node);
    }
    node = node.parentElement;
  }
  return found;
}

function watchFrom(event: WheelEvent, scroller: HTMLElement, previous: Watch | null): Watch {
  const inside =
    previous && previous.target === event.target ? previous.inside : sidewaysScrollersInside(event.target, scroller);
  return {
    left: scroller.scrollLeft,
    target: event.target,
    inside,
    insideLefts: inside.map((each) => each.scrollLeft),
  };
}

function createFollower(): (scroller: HTMLElement, event: WheelEvent) => void {
  let swipe: Swipe | null = null;
  return (scroller, event) => {
    // A pinch arrives as a wheel with the control key, and is the canvas zoom's. A wheel something
    // inside cancelled was taken for its own use, by a terminal or a viewer, and is not stranded.
    if (event.ctrlKey || event.defaultPrevented) return;
    if (!swipe || event.timeStamp - swipe.last > SWIPE_GAP_MS) {
      swipe = { last: event.timeStamp, watch: null, still: 0, stillPx: 0, moving: false, insideOwns: false };
    }
    swipe.last = event.timeStamp;
    if (swipe.insideOwns) return;
    const dx = pixels(event.deltaX, event.deltaMode, scroller.clientWidth);
    const dy = pixels(event.deltaY, event.deltaMode, scroller.clientHeight);
    const sideways = Math.abs(dx) > Math.abs(dy);
    // An up-and-down wheel reads nothing while nothing is stranded: it is most of the wheels this
    // sees, and reading an offset can make the browser lay the page out early.
    if (!swipe.moving && !sideways) {
      swipe.watch = null;
      return;
    }
    const watch = swipe.watch;
    if (!watch) {
      swipe.watch = watchFrom(event, scroller, null);
      return;
    }
    if (watch.inside.some((each, index) => Math.abs(each.scrollLeft - watch.insideLefts[index]!) > SAME)) {
      swipe.insideOwns = true;
      swipe.moving = false;
      return;
    }
    if (Math.abs(scroller.scrollLeft - watch.left) > SAME) {
      // The browser is moving the scroller with this swipe, so it is not stranded.
      swipe.still = 0;
      swipe.stillPx = 0;
      swipe.moving = false;
    } else if (swipe.moving) {
      scroller.scrollLeft += dx;
    } else {
      swipe.still += 1;
      swipe.stillPx += Math.abs(dx);
      if (swipe.still >= STRANDED_WHEELS && swipe.stillPx >= STRANDED_PX) {
        swipe.moving = true;
        scroller.scrollLeft += dx;
      }
    }
    swipe.watch = watchFrom(event, scroller, watch);
  };
}

/** Moves `scroller` sideways by any swipe the browser gave to something inside it that cannot use it. */
export function useStrandedSidewaysWheel(scroller: HTMLElement | null): void {
  const [follow] = useState(createFollower);
  // Bubbling rather than capturing, so it hears a wheel after everything inside has had it.
  useEventListener<WheelEvent>(
    scroller,
    "wheel",
    (event) => {
      if (scroller) follow(scroller, event);
    },
    { passive: true },
  );
}
