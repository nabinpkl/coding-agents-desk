/**
 * Which way a row menu opens.
 *
 * The only thing worth a test here, and it is not cosmetic. A row menu lives inside a scroller more
 * often than not -- a roster, a card, a transcript -- and a scroller clips its children on every
 * side, so a menu that always opened downward would be cut in half on the last rows of a list.
 * Those are exactly the rows a reader reaches for, and the failure is silent: the button responds,
 * the menu is there, and the item is off-screen.
 *
 * jsdom lays nothing out, so the geometry is supplied rather than measured. What is being pinned is
 * the decision made from that geometry, which is the part that can regress.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { GitBranch } from "lucide-react";
import { RowMenu } from "@/features/bots/menus/RowMenu";

/** A scroller 400px tall, with the row at `rowBottom` inside it. */
function scroller(rowBottom: number) {
  const rects = new WeakMap<Element, number>();
  const original = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function fake(this: Element) {
    const bottom = rects.get(this) ?? 0;
    return { bottom, top: 0, left: 0, right: 0, width: 0, height: 120, x: 0, y: 0, toJSON() {} };
  } as typeof original;
  return { rects, restore: () => { Element.prototype.getBoundingClientRect = original; } };
}

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

function open(rowBottom: number, scrollerBottom: number) {
  const geometry = scroller(rowBottom);
  restore = geometry.restore;
  const { container } = render(
    <div data-testid="scroller" style={{ overflowY: "auto" }}>
      <RowMenu label="a row" items={[{ label: "Fork from here", icon: GitBranch, onSelect: vi.fn() }]} />
    </div>,
  );
  geometry.rects.set(screen.getByTestId("scroller"), scrollerBottom);
  geometry.rects.set(screen.getByRole("button", { name: /Actions for/ }), rowBottom);
  fireEvent.click(screen.getByRole("button", { name: /Actions for/ }));
  // Set after render so the menu element exists to be measured on the layout pass.
  return container.querySelector("[role='menu']") as HTMLElement;
}

describe("row menu direction", () => {
  it("opens downward when the row has room below it", () => {
    const menu = open(100, 400);
    expect(menu.className).toContain("top-full");
    expect(menu.className).not.toContain("bottom-full");
  });

  it("opens upward when the scroller would cut it off", () => {
    // 120px of menu below a row ending 40px from the bottom of a 400px scroller: downward would
    // put most of it outside the box, where a scroller clips rather than overflows.
    const menu = open(360, 400);
    expect(menu.className).toContain("bottom-full");
    expect(menu.className).not.toContain("top-full");
  });
});
