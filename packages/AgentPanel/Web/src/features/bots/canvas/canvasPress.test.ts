// What a press on the zoomable canvas landed on, which decides whether the canvas zooms at all.

import { afterEach, describe, expect, it } from "vitest";
import { cardUnder, pressedOnStrip } from "@/features/bots/canvas/canvasPress";

describe("whether a press belongs to a card or to the canvas", () => {
  afterEach(() => document.body.replaceChildren());

  /** The canvas's own shape: a scroller, the strip of cards inside it, and room beside the strip. */
  function canvas() {
    const scroller = document.createElement("div");
    const strip = document.createElement("ul");
    const card = document.createElement("li");
    const room = document.createElement("div");
    strip.append(card);
    scroller.append(strip, room);
    document.body.append(scroller);
    return { scroller, strip, card, room };
  }

  /** What the scroller's listener decides about one click on `target`. */
  function decide(scroller: HTMLElement, strip: HTMLElement, target: HTMLElement) {
    const seen: { onStrip: boolean; contained: boolean }[] = [];
    scroller.addEventListener("click", (event) =>
      seen.push({ onStrip: pressedOnStrip(event, strip), contained: strip.contains(event.target as Node) }),
    );
    target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    return seen[0]!;
  }

  it("gives the card a press on a control that removed itself before the click reached the canvas", () => {
    // The Background tasks panel's X: its handler unmounts the panel on the way up, from a
    // listener inside the card, so the scroller sees a target that is no longer in the page.
    const { scroller, strip, card } = canvas();
    const close = document.createElement("button");
    card.append(close);
    close.addEventListener("click", () => close.remove());

    const seen = decide(scroller, strip, close);

    expect(seen.contained).toBe(false);
    expect(seen.onStrip).toBe(true);
  });

  it("gives the canvas a press beside the strip", () => {
    const { scroller, strip, room } = canvas();

    expect(decide(scroller, strip, room).onStrip).toBe(false);
  });

  it("gives the card an ordinary press inside it", () => {
    const { scroller, strip, card } = canvas();

    expect(decide(scroller, strip, card).onStrip).toBe(true);
  });
});

describe("which card a press landed on", () => {
  const cards = [
    { left: 0, right: 100 },
    { left: 112, right: 212 },
    { left: 224, right: 324 },
  ];

  it("finds the card by x alone, because the strip is one row that never wraps", () => {
    expect(cardUnder(cards, 50)).toBe(0);
    expect(cardUnder(cards, 150)).toBe(1);
    expect(cardUnder(cards, 300)).toBe(2);
  });

  it("says nothing for the gaps between cards and the canvas past them", () => {
    // A press in the gap is a press on the canvas, which means the other gesture entirely, so
    // guessing the nearest card here would zoom a reader somewhere they did not point.
    expect(cardUnder(cards, 106)).toBe(-1);
    expect(cardUnder(cards, 9000)).toBe(-1);
  });
});
