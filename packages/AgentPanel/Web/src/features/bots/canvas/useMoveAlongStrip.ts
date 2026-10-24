// Carrying one card along the strip and dropping it somewhere else in the order.
//
// Its own file because nothing about it is the canvas: it is pointer arithmetic over a row of
// laid-out boxes, and the only thing it knows about what is in them is that they must not be
// re-parented. That constraint is the reason the whole thing exists as transforms; see below.

import { useRef, useState } from "react";
import { STRIP_GAP } from "@/features/bots/cards/botCanvasCards";
import { effectiveScale } from "@/features/bots/canvas/useCanvasZoom";
import { useUnmountEffect } from "@/hooks/useMountEffect";

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
 * Marks a child of the strip that is laid out in it and cannot be carried.
 *
 * The session row is the reason: among a Bot's own sessions it also lays out the ones this panel
 * has started and has nowhere to put yet, a fork not yet sent, and the references whose
 * transcripts have gone missing. None has a place in the Bot's order, so a card dropped on one
 * would be aimed at a position that cannot be expressed, and measuring one would shift every
 * index after it. Unmarked, every child is movable, which is what the canvas strip wants.
 */
export const STRIP_FIXED = "data-strip-fixed";

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
 * transforms this is applying, and the card would chase itself. What moves instead is the scroller:
 * held against an edge, the strip scrolls under the card, and the distance scrolled since the drag
 * began is added to the pointer's, so the card travels with the hand past the edge of the screen
 * rather than being carried back with the strip.
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
  gap = STRIP_GAP,
  onDrop,
}: {
  canvas: React.RefObject<HTMLDivElement | null>;
  list: React.RefObject<HTMLUListElement | null>;
  /**
   * The gap the strip lays its boxes out with, which a card stepping aside has to clear as well.
   *
   * A parameter because this is used at two scales now: the canvas's own strip of Bots, and the
   * row of sessions inside one Bot's card, which stand further apart. Reading it off the element
   * would be better and is not free -- `getComputedStyle` per drag start, for a number the caller
   * already knows from the class it wrote.
   */
  gap?: number;
  onDrop: (from: number, to: number) => void;
}): StripMove {
  const laidOut = useRef<{ left: number; width: number }[]>([]);
  /** What the strip was drawn at when the drag began. Exactly 1 unless the zoom mode is on. */
  const scale = useRef(1);
  const from = useRef(0);
  /** Where the pointer was when the drag began, and where it is now. */
  const pointer = useRef(0);
  const latest = useRef(0);
  /** The scroller's offset when the drag began: the strip moved under the card by the difference. */
  const scrolledFrom = useRef(0);
  /** Which way the edge is scrolling, in screen pixels a frame: 0 while the pointer is clear of both. */
  const edge = useRef(0);
  const scrolling = useRef<number | null>(null);
  const [carried, setCarried] = useState<{ from: number; to: number; dx: number } | null>(null);

  const stopScrolling = (): void => {
    if (scrolling.current !== null) cancelAnimationFrame(scrolling.current);
    scrolling.current = null;
  };

  const measure = (): void => {
    const cards = laidOut.current;
    const held = cards[from.current];
    if (!held) return;
    // Against the strip rather than the window: the strip has slid by whatever the scroller moved
    // since the drag began, and the card is drawn inside the strip, so that distance is added back.
    // Without it the scroll that was meant to reach a far card carried the held one back with it,
    // and no drop could land past the screen's edge. Both are screen pixels, divided into the
    // strip's own laid-out space together.
    const scrolled = (canvas.current?.scrollLeft ?? scrolledFrom.current) - scrolledFrom.current;
    const dx = (latest.current - pointer.current + scrolled) / scale.current;
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
    laidOut.current = [...strip.children]
      .filter((child) => !child.hasAttribute(STRIP_FIXED))
      .map((child) => {
        const box = child.getBoundingClientRect();
        return { left: (box.left - origin) / scale.current, width: box.width / scale.current };
      });
    from.current = index;
    pointer.current = clientX;
    latest.current = clientX;
    scrolledFrom.current = canvas.current?.scrollLeft ?? 0;
    setCarried({ from: index, to: index, dx: 0 });
  };

  const to = (clientX: number): void => {
    latest.current = clientX;
    measure();
    const scroller = canvas.current;
    if (!scroller) return;
    // The edge test and the creep step stay in SCREEN pixels: the margin is how close a hand is to
    // the side of the panel, and `scrollLeft` moves the scroller, which is outside the transform.
    const box = scroller.getBoundingClientRect();
    edge.current =
      clientX > box.right - EDGE_SCROLL_MARGIN
        ? EDGE_SCROLL_STEP
        : clientX < box.left + EDGE_SCROLL_MARGIN
          ? -EDGE_SCROLL_STEP
          : 0;
    if (edge.current === 0) {
      stopScrolling();
      return;
    }
    if (scrolling.current !== null) return;
    // A loop rather than a scroll per pointer event, because holding a card still against the edge
    // is exactly how you reach a card that is off screen, and a still pointer sends no events. It
    // reads the latest pointer and edge each frame, so a hand that moves along the edge is followed,
    // and it stops at the end of the strip, where there is nothing left to scroll to.
    const creep = (): void => {
      const node = canvas.current;
      const before = node?.scrollLeft;
      if (node) node.scrollLeft += edge.current;
      if (!node || node.scrollLeft === before) {
        scrolling.current = null;
        return;
      }
      measure();
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

  useUnmountEffect(stopScrolling);

  return {
    liftedIndex: carried?.from ?? null,
    offsetOf: (index) => {
      if (!carried) return 0;
      if (index === carried.from) return carried.dx;
      const held = laidOut.current[carried.from];
      if (!held) return 0;
      // A card the held one has passed steps aside by exactly the room the held one takes.
      const stride = held.width + gap;
      if (carried.to > carried.from && index > carried.from && index <= carried.to) return -stride;
      if (carried.to < carried.from && index < carried.from && index >= carried.to) return stride;
      return 0;
    },
    start,
    to,
    end,
  };
}
