import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KeyboardDeck } from "./KeyboardDeck";
import {
  DELETE_REPEAT_DELAY_MS,
  DELETE_REPEAT_INTERVAL_MS,
  SHIFT_DOUBLE_TAP_MS,
  SPACE_CURSOR_STEP_PX,
  SPACE_PAN_SLOP_PX,
} from "./keyboardDeckModel";
import { PORTRAIT_DECK } from "./keyboardDeckMetrics";

function renderDeck() {
  const onCharacter = vi.fn();
  const onDelete = vi.fn();
  const onCursorDelta = vi.fn();
  render(
    <KeyboardDeck
      metrics={PORTRAIT_DECK}
      onCharacter={onCharacter}
      onDelete={onDelete}
      onCursorDelta={onCursorDelta}
    />,
  );
  return { onCharacter, onDelete, onCursorDelta };
}

const key = (id: string) => screen.getByTestId(`deck-key-${id}`);
/** jsdom lays nothing out, so a press that reports a position needs one supplied. */
function stubRect(element: Element, rect: Partial<DOMRect>) {
  element.getBoundingClientRect = () => ({
    left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0,
    toJSON: () => ({}), ...rect,
  }) as DOMRect;
}

function press(element: Element, at: Record<string, number> = { clientX: 10, clientY: 10 }) {
  fireEvent.pointerDown(element, { pointerId: 1, clientY: 10, ...at });
}
function release(element: Element, at: Record<string, number> = { clientX: 10, clientY: 10 }) {
  fireEvent.pointerUp(element, { pointerId: 1, clientY: 10, ...at });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("KeyboardDeck", () => {
  it("draws the iPhone's four rows with no globe key", () => {
    renderDeck();
    const rows = screen.getByTestId("keyboard-deck").querySelectorAll(".flex.flex-col > div");
    expect([...rows].map((row) => row.querySelectorAll("button").length)).toEqual([10, 9, 9, 3]);
    expect(screen.queryByLabelText("Next keyboard")).toBeNull();
    expect(key("char-71")).toHaveTextContent("q");
  });

  it("types the character a key shows, and clears an armed shift after one", () => {
    const { onCharacter } = renderDeck();
    press(key("char-71"));
    release(key("char-71"));
    expect(onCharacter).toHaveBeenCalledWith("q");

    press(key("shift"));
    release(key("shift"));
    expect(key("char-71")).toHaveTextContent("Q");
    press(key("char-71"));
    release(key("char-71"));
    expect(onCharacter).toHaveBeenLastCalledWith("Q");
    expect(key("char-71")).toHaveTextContent("q");
  });

  it("locks shift on a second tap inside the double-tap window and not after it", () => {
    vi.useFakeTimers();
    const now = vi.spyOn(performance, "now");
    renderDeck();
    now.mockReturnValue(0);
    press(key("shift"));
    release(key("shift"));
    now.mockReturnValue(SHIFT_DOUBLE_TAP_MS - 1);
    press(key("shift"));
    release(key("shift"));
    expect(key("shift")).toHaveTextContent("⇪");

    // Unlock, then arm again and wait past the window: the second tap turns it off, not locked.
    press(key("shift"));
    release(key("shift"));
    now.mockReturnValue(1000);
    press(key("shift"));
    release(key("shift"));
    now.mockReturnValue(1000 + SHIFT_DOUBLE_TAP_MS + 1);
    press(key("shift"));
    release(key("shift"));
    expect(key("shift")).toHaveTextContent("⇧");
    expect(key("shift")).toHaveAttribute("aria-pressed", "false");
  });

  it("switches pages and drops an armed shift on the way out", () => {
    const { onCharacter } = renderDeck();
    press(key("shift"));
    release(key("shift"));
    press(key("page-numbers"));
    release(key("page-numbers"));
    expect(key("char-31")).toHaveTextContent("1");
    press(key("page-symbols"));
    release(key("page-symbols"));
    // The bullet has no US key position; the deck still offers it and the send path decides how.
    press(key("char-2022"));
    release(key("char-2022"));
    expect(onCharacter).toHaveBeenCalledWith("•");

    press(key("page-alphabet"));
    release(key("page-alphabet"));
    expect(key("char-71")).toHaveTextContent("q");
  });

  it("deletes on press and repeats while held", () => {
    vi.useFakeTimers();
    const { onDelete } = renderDeck();
    press(key("delete"));
    expect(onDelete).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(DELETE_REPEAT_DELAY_MS - 1);
    expect(onDelete).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1 + DELETE_REPEAT_INTERVAL_MS * 3);
    expect(onDelete).toHaveBeenCalledTimes(4);
    release(key("delete"));
    vi.advanceTimersByTime(DELETE_REPEAT_INTERVAL_MS * 5);
    expect(onDelete).toHaveBeenCalledTimes(4);
  });

  it("pans the caret across the space bar instead of typing a space", () => {
    const { onCharacter, onCursorDelta } = renderDeck();
    const space = key("space");
    const move = (clientX: number) =>
      fireEvent.pointerMove(space, { pointerId: 1, clientX, clientY: 10 });
    press(space, { clientX: 100 });
    // The pan is recognised where the slop is crossed, and steps are counted from there, not from
    // where the finger landed.
    move(100 + SPACE_PAN_SLOP_PX);
    expect(onCursorDelta).not.toHaveBeenCalled();
    move(100 + SPACE_PAN_SLOP_PX + SPACE_CURSOR_STEP_PX * 2);
    expect(onCursorDelta).toHaveBeenCalledWith(2);
    move(100 + SPACE_PAN_SLOP_PX - SPACE_CURSOR_STEP_PX);
    expect(onCursorDelta).toHaveBeenLastCalledWith(-3);
    release(space, { clientX: 100 });
    expect(onCharacter).not.toHaveBeenCalled();

    press(space, { clientX: 100 });
    release(space, { clientX: 100 });
    expect(onCharacter).toHaveBeenCalledWith(" ");
  });

  it("types a space that drifted less than the pan slop", () => {
    const { onCharacter, onCursorDelta } = renderDeck();
    const space = key("space");
    press(space, { clientX: 100 });
    fireEvent.pointerMove(space, { pointerId: 1, clientX: 100 + SPACE_PAN_SLOP_PX - 1, clientY: 10 });
    release(space, { clientX: 100 + SPACE_PAN_SLOP_PX - 1 });
    expect(onCursorDelta).not.toHaveBeenCalled();
    expect(onCharacter).toHaveBeenCalledWith(" ");
  });

  it("takes both keys when two thumbs roll across the deck", () => {
    const { onCharacter } = renderDeck();
    const q = key("char-71");
    const w = key("char-77");
    fireEvent.pointerDown(q, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerDown(w, { pointerId: 2, clientX: 50, clientY: 10 });
    expect(q).toHaveAttribute("data-pressed", "true");
    expect(w).toHaveAttribute("data-pressed", "true");
    fireEvent.pointerUp(q, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(w, { pointerId: 2, clientX: 50, clientY: 10 });
    expect(onCharacter.mock.calls.map(([character]) => character)).toEqual(["q", "w"]);
  });

  it("hands the single balloon to the newest finger and keeps it until that one lifts", () => {
    renderDeck();
    stubRect(screen.getByTestId("keyboard-deck"), { left: 0, top: 0, width: 390, height: 236 });
    const q = key("char-71");
    const w = key("char-77");
    stubRect(q, { left: 7, top: 100, right: 39, bottom: 146, width: 32, height: 46 });
    stubRect(w, { left: 45, top: 100, right: 77, bottom: 146, width: 32, height: 46 });

    fireEvent.pointerDown(q, { pointerId: 1, clientX: 10, clientY: 110 });
    expect(screen.getByTestId("deck-key-preview")).toHaveTextContent("q");
    fireEvent.pointerDown(w, { pointerId: 2, clientX: 50, clientY: 110 });
    expect(screen.getByTestId("deck-key-preview")).toHaveTextContent("w");
    // The first finger lifting must not take the second finger's balloon with it.
    fireEvent.pointerUp(q, { pointerId: 1, clientX: 10, clientY: 110 });
    expect(screen.getByTestId("deck-key-preview")).toHaveTextContent("w");
    fireEvent.pointerUp(w, { pointerId: 2, clientX: 50, clientY: 110 });
    expect(screen.queryByTestId("deck-key-preview")).toBeNull();
  });

  it("lights an armed shift and reads its lock state as a tri-state", () => {
    renderDeck();
    expect(key("shift")).toHaveAttribute("data-shift", "off");
    expect(key("shift")).toHaveAttribute("aria-pressed", "false");
    press(key("shift"));
    release(key("shift"));
    expect(key("shift")).toHaveAttribute("data-shift", "on");
    expect(key("shift")).toHaveAttribute("aria-pressed", "mixed");
    expect(key("shift").className).toContain("bg-[rgba(0,122,255,0.42)]");
    press(key("shift"));
    release(key("shift"));
    expect(key("shift")).toHaveAttribute("aria-pressed", "true");
  });

  it("cancels a key the finger slid off, the way a drag-exit does", () => {
    const { onCharacter } = renderDeck();
    const q = key("char-71");
    stubRect(q, { left: 0, top: 0, right: 32, bottom: 46, width: 32, height: 46 });
    // Capturing the pointer is what keeps a mouse drag reporting to the key it started on, so a
    // drag onto the neighbour cancels this key rather than committing it on release over there.
    const capture = vi.fn();
    (q as HTMLElement & { setPointerCapture: unknown }).setPointerCapture = capture;
    press(q, { clientX: 10, clientY: 10 });
    expect(capture).toHaveBeenCalledWith(1);
    expect(q).toHaveAttribute("data-pressed", "true");
    fireEvent.pointerMove(q, { pointerId: 1, clientX: 200, clientY: 10 });
    expect(q).toHaveAttribute("data-pressed", "false");
    release(q, { clientX: 200, clientY: 10 });
    expect(onCharacter).not.toHaveBeenCalled();
  });

  it("pops a preview over a held character key, showing the shifted glyph", () => {
    renderDeck();
    stubRect(screen.getByTestId("keyboard-deck"), { left: 0, top: 0, width: 390, height: 236 });
    const q = key("char-71");
    stubRect(q, { left: 7, top: 100, right: 39, bottom: 146, width: 32, height: 46 });

    press(q);
    expect(screen.getByTestId("deck-key-preview")).toHaveTextContent("q");
    release(q);
    expect(screen.queryByTestId("deck-key-preview")).toBeNull();

    press(key("shift"));
    release(key("shift"));
    press(q);
    expect(screen.getByTestId("deck-key-preview")).toHaveTextContent("Q");
    release(q);
  });

  it("does not preview a special key", () => {
    renderDeck();
    press(key("shift"));
    expect(screen.queryByTestId("deck-key-preview")).toBeNull();
    release(key("shift"));
    press(key("delete"));
    expect(screen.queryByTestId("deck-key-preview")).toBeNull();
    release(key("delete"));
  });

  it("centres the home row on the top row's key width and widens the outer gaps", () => {
    renderDeck();
    // Top row stretches by weight; home row takes the shared width so it centres at a half-key.
    expect(key("char-71").style.flexGrow).toBe("0.88");
    expect(key("char-71").style.width).toBe("");
    expect(key("char-61").style.width).toBe("var(--kbd-key-w)");
    expect(key("char-61").style.flexGrow).toBe("0");

    const outer = PORTRAIT_DECK.alphabetOuterKeyGap - PORTRAIT_DECK.horizontalKeyGap;
    expect(key("char-7a").style.marginLeft).toBe(`${outer}px`);
    expect(key("delete").style.marginLeft).toBe(`${outer}px`);
    expect(key("char-78").style.marginLeft).toBe("");
    expect(key("shift").style.flexGrow).toBe("1.25");
    expect(key("space").style.flexGrow).toBe("3.4");
  });

  it("keeps the wider gaps off the number and symbol pages", () => {
    renderDeck();
    press(key("page-numbers"));
    release(key("page-numbers"));
    expect(key("delete").style.marginLeft).toBe("");
    expect(key("char-2e").style.width).toBe("");
  });
});
