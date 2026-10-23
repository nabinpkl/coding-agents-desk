/**
 * Selecting text in a transcript offers to ask a fork about it: where the button goes, when it
 * shows, and what it hands on.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { placeAskButton, SelectionAsk } from "@/features/activity-feed/SelectionAsk";

const rect = (top: number, left: number, height: number, width: number) =>
  ({ top, left, bottom: top + height, right: left + width, height, width, x: left, y: top }) as DOMRect;

const BOX = rect(100, 0, 400, 800);
const BUTTON = rect(0, 0, 36, 140);

describe("where the ask button sits", () => {
  beforeEach(() => {
    vi.stubGlobal("innerWidth", 800);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("goes below the selection's last line, centred on where it ends", () => {
    expect(placeAskButton([rect(200, 40, 20, 300), rect(220, 0, 20, 160)], BOX, BUTTON)).toEqual({
      top: 254,
      left: 90,
    });
  });

  it("goes above the first line when the box has no room below, and stays inside the window", () => {
    expect(placeAskButton([rect(440, 700, 20, 100)], BOX, BUTTON)).toEqual({ top: 390, left: 652 });
  });

  it("is not shown once the selection has scrolled out of its box", () => {
    expect(placeAskButton([rect(20, 0, 20, 100)], BOX, BUTTON)).toBeNull();
    expect(placeAskButton([], BOX, BUTTON)).toBeNull();
  });
});

describe("the ask button", () => {
  beforeEach(() => {
    vi.stubGlobal("innerWidth", 800);
    // jsdom lays nothing out, so the range is given lines inside the box.
    Range.prototype.getClientRects = () => [rect(200, 40, 20, 300)] as unknown as DOMRectList;
  });
  afterEach(() => {
    cleanup();
    document.getSelection()?.removeAllRanges();
    vi.unstubAllGlobals();
  });

  function select(node: Node) {
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    act(() => {
      document.dispatchEvent(new Event("selectionchange"));
    });
  }

  function mount(onAsk: (quote: string) => void) {
    const view = render(<SelectionAsk within={null} onAsk={onAsk} />);
    // The transcript's box arrives after the component, as it does on the page.
    const box = document.createElement("div");
    const paragraph = document.createElement("p");
    paragraph.textContent = "the rewind proves the row";
    box.append(paragraph);
    document.body.append(box);
    box.getBoundingClientRect = () => BOX;
    view.rerender(<SelectionAsk within={box} onAsk={onAsk} />);
    return { box, paragraph };
  }

  it("offers the selected text, hands it on when pressed, and lets the selection go", () => {
    const onAsk = vi.fn();
    const { paragraph } = mount(onAsk);
    expect(screen.queryByRole("button", { name: /Ask about this/ })).toBeNull();
    select(paragraph);
    fireEvent.click(screen.getByRole("button", { name: /Ask about this/ }));
    expect(onAsk).toHaveBeenCalledWith("the rewind proves the row");
    expect(document.getSelection()?.isCollapsed).toBe(true);
    expect(screen.queryByRole("button", { name: /Ask about this/ })).toBeNull();
  });

  it("leaves a selection outside the transcript alone", () => {
    mount(vi.fn());
    const elsewhere = document.createElement("p");
    elsewhere.textContent = "the composer";
    document.body.append(elsewhere);
    select(elsewhere);
    expect(screen.queryByRole("button", { name: /Ask about this/ })).toBeNull();
  });

  it("waits for a mouse drag to end before it shows", () => {
    const { paragraph } = mount(vi.fn());
    fireEvent.pointerDown(paragraph, { pointerType: "mouse" });
    select(paragraph);
    expect(screen.queryByRole("button", { name: /Ask about this/ })).toBeNull();
    fireEvent.pointerUp(paragraph, { pointerType: "mouse" });
    expect(screen.getByRole("button", { name: /Ask about this/ })).toBeDefined();
  });

  it("is still there to take a tap that clears the selection before its click", () => {
    const onAsk = vi.fn();
    const { paragraph } = mount(onAsk);
    select(paragraph);
    const button = screen.getByRole("button", { name: /Ask about this/ });
    fireEvent.pointerDown(button, { pointerType: "touch" });
    act(() => {
      document.getSelection()?.removeAllRanges();
      document.dispatchEvent(new Event("selectionchange"));
    });
    fireEvent.click(button);
    expect(onAsk).toHaveBeenCalledWith("the rewind proves the row");
  });
});
