// What a press on the zoomable canvas landed on: a card, or the empty canvas around the strip.
//
// Its own file because it is the decision the canvas's click gesture turns on, and it is a
// question about the event rather than about the zoom arithmetic `useCanvasZoom.ts` holds.

/**
 * Whether a press reached the canvas through the strip, which makes it the card's and not the
 * canvas's.
 *
 * Read off the path the browser fixed when the event began, not off where the target sits now. A
 * control that removes itself when pressed -- a card's Background tasks panel closing from its own
 * X -- is already out of the document by the time the click bubbles to the scroller: React listens
 * on the portal host inside the card and commits before the event climbs past it. Asking the strip
 * whether it contains that target answered no, the press counted as one on the empty canvas, and
 * closing the panel zoomed the canvas out to fit (or in, to whatever card was under the X).
 */
export function pressedOnStrip(event: Event, strip: Node): boolean {
  return event.composedPath().includes(strip);
}

/**
 * Which card a press landed on, by x alone: the strip is one row that never wraps, so x is the
 * whole address. Screen coordinates, because that is the one space where the boxes and the press
 * are already in the same units and no conversion can be got wrong. -1 for a press beside them.
 */
export function cardUnder(cards: readonly { left: number; right: number }[], x: number): number {
  return cards.findIndex((card) => x >= card.left && x < card.right);
}
