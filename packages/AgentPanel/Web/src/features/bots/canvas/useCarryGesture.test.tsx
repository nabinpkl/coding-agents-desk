// Pressing a card to carry it: a mouse once it has moved, a finger once it has held still, and a
// finger that moves first left to scroll the canvas.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { CARRY_HOLD_MS, useCarryGesture } from "@/features/bots/canvas/useCarryGesture";

const calls: string[] = [];

function Handle() {
  const { attach, handlers, carried } = useCarryGesture<HTMLDivElement>({
    onStart: (x) => calls.push(`start ${x}`),
    onMove: (x) => calls.push(`move ${x}`),
    onEnd: () => calls.push("end"),
    ignore: (target) => target.closest("button") !== null,
  });
  return (
    <div data-testid="handle" ref={attach} {...handlers} onClick={() => calls.push(`click ${carried()}`)}>
      <button type="button">menu</button>
    </div>
  );
}

/** A touchmove the page would scroll on, and whether the handle stopped it. */
function touchMoveScrolls(target: Element): boolean {
  const event = new Event("touchmove", { bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return !event.defaultPrevented;
}

describe("useCarryGesture", () => {
  beforeEach(() => {
    calls.length = 0;
    vi.useFakeTimers();
    HTMLElement.prototype.setPointerCapture = vi.fn();
    HTMLElement.prototype.releasePointerCapture = vi.fn();
    Object.defineProperty(navigator, "vibrate", { value: vi.fn(), configurable: true });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("carries a mouse once it has moved a few pixels, so a click stays a click", () => {
    render(<Handle />);
    const handle = screen.getByTestId("handle");
    fireEvent.pointerDown(handle, { pointerId: 1, pointerType: "mouse", clientX: 100, clientY: 10 });
    fireEvent.pointerMove(handle, { pointerId: 1, pointerType: "mouse", clientX: 103, clientY: 10 });
    expect(calls).toEqual([]);
    fireEvent.pointerMove(handle, { pointerId: 1, pointerType: "mouse", clientX: 110, clientY: 10 });
    fireEvent.pointerUp(handle, { pointerId: 1, pointerType: "mouse", clientX: 110, clientY: 10 });
    fireEvent.click(handle);
    expect(calls).toEqual(["start 100", "move 110", "end", "click true"]);
    // A mouse is already moving when it carries, so there is no pick-up to announce.
    expect(navigator.vibrate).not.toHaveBeenCalled();
  });

  it("picks a card up under a finger held still, and stops the page scrolling while it carries", () => {
    render(<Handle />);
    const handle = screen.getByTestId("handle");
    fireEvent.pointerDown(handle, { pointerId: 2, pointerType: "touch", clientX: 100, clientY: 10 });
    // Within the wobble a finger is allowed, and not yet held long enough.
    fireEvent.pointerMove(handle, { pointerId: 2, pointerType: "touch", clientX: 104, clientY: 12 });
    vi.advanceTimersByTime(CARRY_HOLD_MS - 1);
    expect(calls).toEqual([]);
    expect(touchMoveScrolls(handle)).toBe(true);

    vi.advanceTimersByTime(1);
    expect(calls).toEqual(["start 100", "move 104"]);
    expect(navigator.vibrate).toHaveBeenCalledWith(10);
    expect(touchMoveScrolls(handle)).toBe(false);
    fireEvent.pointerMove(handle, { pointerId: 2, pointerType: "touch", clientX: 300, clientY: 14 });
    fireEvent.pointerUp(handle, { pointerId: 2, pointerType: "touch", clientX: 300, clientY: 14 });
    expect(calls).toEqual(["start 100", "move 104", "move 300", "end"]);
    // The press is over, so the page scrolls again.
    expect(touchMoveScrolls(handle)).toBe(true);
  });

  it("leaves a finger that moves before the hold to scroll the canvas", () => {
    render(<Handle />);
    const handle = screen.getByTestId("handle");
    fireEvent.pointerDown(handle, { pointerId: 3, pointerType: "touch", clientX: 100, clientY: 10 });
    fireEvent.pointerMove(handle, { pointerId: 3, pointerType: "touch", clientX: 130, clientY: 10 });
    vi.advanceTimersByTime(CARRY_HOLD_MS * 2);
    fireEvent.pointerCancel(handle, { pointerId: 3, pointerType: "touch" });
    expect(calls).toEqual([]);
    expect(touchMoveScrolls(handle)).toBe(true);
  });

  it("never starts from a control inside the handle, and keeps the browser's menu off a held finger", () => {
    render(<Handle />);
    const menu = screen.getByRole("button", { name: "menu" });
    fireEvent.pointerDown(menu, { pointerId: 4, pointerType: "touch", clientX: 100, clientY: 10 });
    vi.advanceTimersByTime(CARRY_HOLD_MS);
    expect(calls).toEqual([]);

    const handle = screen.getByTestId("handle");
    fireEvent.pointerDown(handle, { pointerId: 5, pointerType: "touch", clientX: 100, clientY: 10 });
    expect(fireEvent.contextMenu(handle)).toBe(false);
  });
});
