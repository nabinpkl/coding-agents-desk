// Carrying one card along the strip and dropping it somewhere else in the order.
//
// Its own file because nothing about it is the canvas: it is pointer arithmetic over a row of
// laid-out boxes, and the only thing it knows about what is in them is that they must not be
// re-parented. That constraint is the reason the whole thing exists as transforms; see below.

import { useCallback, useEffect, useRef, useState } from "react";
import { STRIP_GAP } from "@/features/bots/cards/botCanvasCards";
import { effectiveScale } from "@/features/bots/useCanvasZoom";

/** How close to an edge a drag has to get before the strip scrolls itself, and how fast. */
const EDGE_SCROLL_MARGIN = 56;
const EDGE_SCROLL_STEP = 14;

export interface StripMove {
  /** The index being carried, or null when nothing is. */
  liftedIndex: number | null;
  /** How far the card at `index` is displaced from where the strip laid it out. */
  offsetOf: (index: number) => number;
  start: (index: number, clientX: number) => void;
  to: (clientX: number) => void;
  end: () => void;
}

/**
 * Carrying one card along the strip and dropping it somewhere else in the order.
 *
 * Everything moves by TRANSFORM and nothing is re-parented, which is not a rendering preference: a
 * card can hold a live session -- an event stream, a background-task stream, a summary probe, a
 * CLI-status poll, and once its terminal is open, a pty attach. Rendering the card being dragged
 * into a layer of its own would unmount `SessionView` and stand every one of those back up on
 * drop, so the card stays exactly where it is in the tree and is merely drawn somewhere else.
 *
 * Positions are read ONCE, when the drag begins. Reading them again mid-drag would be reading the
 * transforms this is applying, and the card would chase itself.
 *
 * Two coordinate systems meet here and the canvas's zoom mode is what makes the difference visible.
 * A rect is what the card is DRAWN at; a `translateX` inside the strip is applied in the strip's
 * own laid-out space, before the scale. So every measurement taken off a rect is divided back into
 * layout space, and the scale is read once at the same moment the positions are, for the same
 * reason. With the mode off it is exactly 1 and every division below is a no-op.
 */
export function useMoveAlongStrip({
  canvas,
  list,
  onDrop,
}: {
  canvas: React.RefObject<HTMLDivElement | null>;
  list: React.RefObject<HTMLUListElement | null>;
  onDrop: (from: number, to: number) => void;
}): StripMove {
  const laidOut = useRef<{ left: number; width: number }[]>([]);
  /** What the strip was drawn at when the drag began. Exactly 1 unless the zoom mode is on. */
  const scale = useRef(1);
  const from = useRef(0);
  const pointer = useRef(0);
  const scrolling = useRef<number | null>(null);
  const [carried, setCarried] = useState<{ from: number; to: number; dx: number } | null>(null);

  const stopScrolling = (): void => {
    if (scrolling.current !== null) cancelAnimationFrame(scrolling.current);
    scrolling.current = null;
  };

  const measure = (clientX: number): void => {
    const cards = laidOut.current;
    const held = cards[from.current];
    if (!held) return;
    // Against the strip rather than the window, so scrolling under the drag does not read as the
    // pointer having moved.
    const dx = (clientX - pointer.current) / scale.current;
    const centre = held.left + dx + held.width / 2;
    let to = from.current;
    for (let i = 0; i < cards.length; i += 1) {
      if (i === from.current) continue;
      const other = cards[i]!;
      const otherCentre = other.left + other.width / 2;
      if (i > from.current && centre > otherCentre) to = Math.max(to, i);
      if (i < from.current && centre < otherCentre) to = Math.min(to, i);
    }
    setCarried({ from: from.current, to, dx });
  };

  const start = (index: number, clientX: number): void => {
    const strip = list.current;
    if (!strip) return;
    scale.current = effectiveScale(strip);
    const origin = strip.getBoundingClientRect().left;
    laidOut.current = [...strip.children].map((child) => {
      const box = child.getBoundingClientRect();
      return { left: (box.left - origin) / scale.current, width: box.width / scale.current };
    });
    from.current = index;
    pointer.current = clientX;
    setCarried({ from: index, to: index, dx: 0 });
  };

  const to = (clientX: number): void => {
    measure(clientX);
    const scroller = canvas.current;
    if (!scroller) return;
    // The edge test and the creep step stay in SCREEN pixels: the margin is how close a hand is to
    // the side of the panel, and `scrollLeft` moves the scroller, which is outside the transform.
    const box = scroller.getBoundingClientRect();
    const step =
      clientX > box.right - EDGE_SCROLL_MARGIN
        ? EDGE_SCROLL_STEP
        : clientX < box.left + EDGE_SCROLL_MARGIN
          ? -EDGE_SCROLL_STEP
          : 0;
    if (step === 0) {
      stopScrolling();
      return;
    }
    if (scrolling.current !== null) return;
    // A loop rather than a scroll per pointer event, because holding a card still against the edge
    // is exactly how you reach a card that is off screen, and a still pointer sends no events.
    const creep = (): void => {
      const node = canvas.current;
      if (!node) return;
      node.scrollLeft += step;
      measure(clientX);
      scrolling.current = requestAnimationFrame(creep);
    };
    scrolling.current = requestAnimationFrame(creep);
  };

  const end = (): void => {
    stopScrolling();
    const held = carried;
    setCarried(null);
    if (held && held.to !== held.from) onDrop(held.from, held.to);
  };

  useEffect(() => stopScrolling, []);

  return {
    liftedIndex: carried?.from ?? null,
    offsetOf: (index) => {
      if (!carried) return 0;
      if (index === carried.from) return carried.dx;
      const held = laidOut.current[carried.from];
      if (!held) return 0;
      // A card the held one has passed steps aside by exactly the room the held one takes.
      const stride = held.width + STRIP_GAP;
      if (carried.to > carried.from && index > carried.from && index <= carried.to) return -stride;
      if (carried.to < carried.from && index < carried.from && index >= carried.to) return stride;
      return 0;
    },
    start,
    to,
    end,
  };
}
