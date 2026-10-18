/**
 * Where a row menu goes when it opens, and what does NOT get a say in it.
 *
 * The thing worth pinning, and it is not cosmetic. Every canvas card sets `overflow-hidden` to keep
 * its content inside its rounded corners, and a menu rendered as a child of that card is cut off at
 * the card's edge rather than allowed to overflow the page. Picking a direction is not a fix for
 * that -- on a card shorter than the menu neither direction fits, and the last items are simply
 * unreachable on exactly the short cards a reader collapses a session down to.
 *
 * So the menu is portalled to `document.body` and placed `fixed` against the window. These tests
 * say that in the two ways that can regress: the menu is not in the card's subtree, and the card's
 * geometry does not appear in the placement. The scrolled-away case is here too, because that is
 * the one thing portalling takes away -- a menu in the body has no idea its row has gone.
 *
 * jsdom lays nothing out, so the geometry is supplied rather than measured. What is being pinned is
 * the decision made from that geometry.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { GitBranch } from "lucide-react";
import { RowMenu } from "@/features/bots/menus/RowMenu";

/** jsdom's window, which the placement measures against. */
const VIEWPORT = { width: 1024, height: 768 };
/** The menu's own size, the same in every case here so the arithmetic stays readable. */
const MENU = { width: 176, height: 240 };

function box({ top, left, width, height }: { top: number; left: number; width: number; height: number }) {
  return {
    top,
    left,
    width,
    height,
    bottom: top + height,
    right: left + width,
    x: left,
    y: top,
    toJSON() {},
  } as DOMRect;
}

/** Answers `getBoundingClientRect` from a lookup instead of from a layout nobody performed. */
function stubRects(resolve: (element: Element) => DOMRect | undefined) {
  const original = Element.prototype.getBoundingClientRect;
  const empty = box({ top: 0, left: 0, width: 0, height: 0 });
  Element.prototype.getBoundingClientRect = function fake(this: Element) {
    return resolve(this) ?? empty;
  };
  return () => {
    Element.prototype.getBoundingClientRect = original;
  };
}

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

/**
 * A card that clips, with one row menu in it.
 *
 * `card` is the box the old implementation measured against and this one must not: pass a short one
 * and the placement should be unmoved.
 */
function open({ card, trigger }: { card: DOMRect; trigger: DOMRect }) {
  restore = stubRects((element) => {
    if (element.matches("[role='menu']")) return box({ top: 0, left: 0, ...MENU });
    if (element.matches("button[aria-haspopup='menu']")) return trigger;
    if (element.matches("[data-testid='card']")) return card;
    return undefined;
  });
  render(
    // `overflowY` rather than the `overflow` shorthand: jsdom's computed style does not expand
    // shorthands, and the real card's Tailwind `overflow-hidden` does reach both axes in a browser.
    <div data-testid="card" style={{ overflowY: "hidden" }}>
      <RowMenu label="a row" items={[{ label: "Fork from here", icon: GitBranch, onSelect: vi.fn() }]} />
    </div>,
  );
  fireEvent.click(screen.getByRole("button", { name: /Actions for/ }));
  return screen.getByRole("menu") as HTMLElement;
}

/** A row near the bottom of a short card, with most of the window still below it. */
const SHORT_CARD = box({ top: 100, left: 0, width: 400, height: 120 });
const ROW_IN_SHORT_CARD = box({ top: 178, left: 360, width: 32, height: 32 });

describe("row menu placement", () => {
  it("renders into the body, not into the card that would clip it", () => {
    const menu = open({ card: SHORT_CARD, trigger: ROW_IN_SHORT_CARD });

    expect(menu.closest("[data-testid='card']")).toBeNull();
    expect(menu.parentElement).toBe(document.body);
  });

  it("keeps the card's height out of the placement, which is the whole point", () => {
    // The menu is 240 tall and the card is 120: there is no direction that fits INSIDE this card,
    // which is why the card cannot be what decides. The window has 558px below the row.
    const menu = open({ card: SHORT_CARD, trigger: ROW_IN_SHORT_CARD });

    expect(menu.className).toContain("fixed");
    expect(menu.style.top).toBe(`${ROW_IN_SHORT_CARD.bottom + 4}px`);
  });

  it("opens upward when the WINDOW has no room below the row", () => {
    const trigger = box({ top: 700, left: 360, width: 32, height: 32 });
    const menu = open({ card: box({ top: 0, left: 0, width: 400, height: 768 }), trigger });

    // 36px below the row inside the window, against 240 of menu, and 692 above it.
    expect(menu.style.top).toBe(`${trigger.top - 4 - MENU.height}px`);
  });

  it("right-aligns to the row, and clamps so an edge row still gets a whole menu", () => {
    const inset = box({ top: 178, left: 300, width: 32, height: 32 });
    expect(open({ card: SHORT_CARD, trigger: inset }).style.left).toBe(`${inset.right - MENU.width}px`);
    cleanup();
    restore?.();

    // A row against the right edge of a full-width card: right-aligning would put the menu's own
    // right edge past the window, so it stops one margin short instead.
    const wide = box({ top: 100, left: 0, width: VIEWPORT.width, height: 120 });
    const edge = box({ top: 178, left: VIEWPORT.width - 32, width: 32, height: 32 });
    expect(open({ card: wide, trigger: edge }).style.left).toBe(`${VIEWPORT.width - 8 - MENU.width}px`);
  });

  it("closes when the row it names is scrolled out of the card", () => {
    // Opened while the row is inside the card, then the card scrolls it away above the top edge.
    // A menu in the body cannot be clipped out of sight with its row, so it has to leave on its
    // own, and the scroll event of an inner scroller is the only notice it gets.
    let trigger = ROW_IN_SHORT_CARD;
    restore = stubRects((element) => {
      if (element.matches("[role='menu']")) return box({ top: 0, left: 0, ...MENU });
      if (element.matches("button[aria-haspopup='menu']")) return trigger;
      if (element.matches("[data-testid='card']")) return SHORT_CARD;
      return undefined;
    });
    render(
      <div data-testid="card" style={{ overflowY: "auto" }}>
        <RowMenu label="a row" items={[{ label: "Fork from here", icon: GitBranch, onSelect: vi.fn() }]} />
      </div>,
    );
    fireEvent.click(screen.getByRole("button", { name: /Actions for/ }));
    expect(screen.queryByRole("menu")).not.toBeNull();

    trigger = box({ top: SHORT_CARD.top - 80, left: 360, width: 32, height: 32 });
    // On the card, not on the window: a scroll event does not bubble, so this also says the
    // listener is in the capture phase rather than waiting for one that never arrives.
    fireEvent.scroll(screen.getByTestId("card"));

    expect(screen.queryByRole("menu")).toBeNull();
  });
});
