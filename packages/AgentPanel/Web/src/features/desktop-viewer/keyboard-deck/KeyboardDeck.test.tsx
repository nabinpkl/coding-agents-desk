import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KeyboardDeck } from "@/features/desktop-viewer/keyboard-deck/KeyboardDeck";
import {
  DELETE_REPEAT_DELAY_MS,
  DELETE_REPEAT_INTERVAL_MS,
  SHIFT_DOUBLE_TAP_MS,
  SPACE_CURSOR_STEP_PX,
  SPACE_PAN_SLOP_PX,
} from "@/features/desktop-viewer/keyboard-deck/keyboardDeckModel";
import { PORTRAIT_DECK } from "@/features/desktop-viewer/keyboard-deck/keyboardDeckMetrics";
import { stubDeckLayout } from "@/features/desktop-viewer/keyboard-deck/keyboardDeckTestLayout";

const deck = () => screen.getByTestId("keyboard-deck");
const key = (id: string) => screen.getByTestId(`deck-key-${id}`);

function renderDeck() {
  const onCharacter = vi.fn();
  const onDelete = vi.fn();
  const onCursorDelta = vi.fn();
  const onSwitchToNative = vi.fn();
  render(
    <KeyboardDeck
      metrics={PORTRAIT_DECK}
      onCharacter={onCharacter}
      onDelete={onDelete}
      onCursorDelta={onCursorDelta}
      onSwitchToNative={onSwitchToNative}
    />,
  );
  stubDeckLayout(deck());
  return { onCharacter, onDelete, onCursorDelta, onSwitchToNative };
}

/** The centre of a key, in the coordinates the deck's handlers read. */
function centreOf(id: string) {
  const bounds = key(id).getBoundingClientRect();
  return { clientX: (bounds.left + bounds.right) / 2, clientY: (bounds.top + bounds.bottom) / 2 };
}

type At = { pointerId?: number; clientX?: number; clientY?: number };

function press(id: string, { pointerId = 1, ...at }: At = {}) {
  fireEvent.pointerDown(deck(), { pointerId, ...centreOf(id), ...at });
}
function release(id: string, { pointerId = 1, ...at }: At = {}) {
  fireEvent.pointerUp(deck(), { pointerId, ...centreOf(id), ...at });
}
function moveTo(clientX: number, clientY: number, pointerId = 1) {
  fireEvent.pointerMove(deck(), { pointerId, clientX, clientY });
}
function tap(id: string, pointerId = 1) {
  press(id, { pointerId });
  release(id, { pointerId });
}
const typed = (fn: ReturnType<typeof vi.fn>) => fn.mock.calls.map((call) => String(call[0])).join("");

afterEach(() => {
  vi.useRealTimers();
});

describe("KeyboardDeck", () => {
  it("draws the iPhone's four rows with no globe key", () => {
    renderDeck();
    const rows = deck().querySelectorAll("[data-deck-row]");
    expect([...rows].map((row) => row.querySelectorAll("button").length)).toEqual([10, 9, 9, 4]);
    expect(screen.queryByLabelText("Next keyboard")).toBeNull();
    expect(key("char-71")).toHaveTextContent("q");
  });

  it("types the character a key shows, and clears an armed shift after one", () => {
    const { onCharacter } = renderDeck();
    tap("char-71");
    expect(onCharacter).toHaveBeenCalledWith("q");

    tap("shift");
    expect(key("char-71")).toHaveTextContent("Q");
    tap("char-71");
    expect(onCharacter).toHaveBeenLastCalledWith("Q");
    expect(key("char-71")).toHaveTextContent("q");
  });

  it("locks shift on a second tap inside the double-tap window and not after it", () => {
    const now = vi.spyOn(performance, "now");
    renderDeck();
    now.mockReturnValue(0);
    tap("shift");
    now.mockReturnValue(SHIFT_DOUBLE_TAP_MS - 1);
    tap("shift");
    expect(key("shift")).toHaveTextContent("⇪");

    tap("shift");
    now.mockReturnValue(1000);
    tap("shift");
    now.mockReturnValue(1000 + SHIFT_DOUBLE_TAP_MS + 1);
    tap("shift");
    expect(key("shift")).toHaveTextContent("⇧");
    expect(key("shift")).toHaveAttribute("aria-pressed", "false");
    now.mockRestore();
  });

  it("switches pages and drops an armed shift on the way out", () => {
    const { onCharacter } = renderDeck();
    tap("shift");
    tap("page-numbers");
    stubDeckLayout(deck());
    expect(key("char-31")).toHaveTextContent("1");
    tap("page-symbols");
    stubDeckLayout(deck());
    // The bullet has no US key position; the deck still offers it and the send path decides how.
    tap("char-2022");
    expect(onCharacter).toHaveBeenCalledWith("•");

    tap("page-alphabet");
    stubDeckLayout(deck());
    expect(key("char-71")).toHaveTextContent("q");
  });

  it("deletes on press and repeats while held", () => {
    vi.useFakeTimers();
    const { onDelete } = renderDeck();
    press("delete");
    expect(onDelete).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(DELETE_REPEAT_DELAY_MS - 1);
    expect(onDelete).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1 + DELETE_REPEAT_INTERVAL_MS * 3);
    expect(onDelete).toHaveBeenCalledTimes(4);
    release("delete");
    vi.advanceTimersByTime(DELETE_REPEAT_INTERVAL_MS * 5);
    expect(onDelete).toHaveBeenCalledTimes(4);
  });

  it("pans the caret across the space bar instead of typing a space", () => {
    const { onCharacter, onCursorDelta } = renderDeck();
    const start = centreOf("space");
    press("space");
    // The pan is recognised where the slop is crossed, and steps are counted from there, not from
    // where the finger landed.
    moveTo(start.clientX + SPACE_PAN_SLOP_PX, start.clientY);
    expect(onCursorDelta).not.toHaveBeenCalled();
    moveTo(start.clientX + SPACE_PAN_SLOP_PX + SPACE_CURSOR_STEP_PX * 2, start.clientY);
    expect(onCursorDelta).toHaveBeenCalledWith(2);
    moveTo(start.clientX + SPACE_PAN_SLOP_PX - SPACE_CURSOR_STEP_PX, start.clientY);
    expect(onCursorDelta).toHaveBeenLastCalledWith(-3);
    release("space");
    expect(onCharacter).not.toHaveBeenCalled();

    tap("space");
    expect(onCharacter).toHaveBeenCalledWith(" ");
  });

  it("types a space that drifted less than the pan slop", () => {
    const { onCharacter, onCursorDelta } = renderDeck();
    const start = centreOf("space");
    press("space");
    moveTo(start.clientX + SPACE_PAN_SLOP_PX - 1, start.clientY);
    release("space");
    expect(onCursorDelta).not.toHaveBeenCalled();
    expect(onCharacter).toHaveBeenCalledWith(" ");
  });

  it("follows the finger across keys and types the one it lands on", () => {
    const { onCharacter } = renderDeck();
    press("char-71");
    expect(key("char-71")).toHaveAttribute("data-pressed", "true");
    const away = centreOf("char-70");
    moveTo(away.clientX, away.clientY);
    // The press moves with the finger rather than being abandoned: stock iPhone behaviour, and a
    // deliberate departure from the Swift keyboard, whose buttons give up on drag-exit.
    expect(key("char-71")).toHaveAttribute("data-pressed", "false");
    expect(key("char-70")).toHaveAttribute("data-pressed", "true");
    release("char-70");
    expect(onCharacter).toHaveBeenCalledExactlyOnceWith("p");
  });

  it("moves the balloon to the key the finger has moved onto", () => {
    renderDeck();
    press("char-71");
    expect(screen.getByTestId("deck-key-preview")).toHaveTextContent("q");
    const w = centreOf("char-77");
    moveTo(w.clientX, w.clientY);
    expect(screen.getByTestId("deck-key-preview")).toHaveTextContent("w");
    // A special key has no balloon, so moving onto one takes it away.
    const shift = centreOf("shift");
    moveTo(shift.clientX, shift.clientY);
    expect(screen.queryByTestId("deck-key-preview")).toBeNull();
    release("shift");
  });

  it("abandons the press only when the finger leaves the deck", () => {
    const { onCharacter } = renderDeck();
    press("char-71");
    moveTo(20, -20);
    expect(key("char-71")).toHaveAttribute("data-pressed", "false");
    release("char-71", { clientX: 20, clientY: -20 });
    expect(onCharacter).not.toHaveBeenCalled();
  });

  it("ends a held delete when the finger leaves it, rather than handing the press on", () => {
    vi.useFakeTimers();
    const { onDelete, onCharacter } = renderDeck();
    press("delete");
    expect(onDelete).toHaveBeenCalledTimes(1);
    const away = centreOf("char-6d");
    moveTo(away.clientX, away.clientY);
    vi.advanceTimersByTime(DELETE_REPEAT_DELAY_MS + DELETE_REPEAT_INTERVAL_MS * 3);
    expect(onDelete).toHaveBeenCalledTimes(1);
    release("char-6d");
    expect(onCharacter).not.toHaveBeenCalled();
  });

  it("pops a preview over a held character key, showing the shifted glyph", () => {
    renderDeck();
    press("char-71");
    expect(screen.getByTestId("deck-key-preview")).toHaveTextContent("q");
    release("char-71");
    expect(screen.queryByTestId("deck-key-preview")).toBeNull();

    tap("shift");
    press("char-71");
    expect(screen.getByTestId("deck-key-preview")).toHaveTextContent("Q");
    release("char-71");
  });

  it("does not preview a special key", () => {
    renderDeck();
    press("shift");
    expect(screen.queryByTestId("deck-key-preview")).toBeNull();
    release("shift");
    press("delete");
    expect(screen.queryByTestId("deck-key-preview")).toBeNull();
    release("delete");
  });

  it("hands the single balloon to the newest finger and keeps it until that one lifts", () => {
    renderDeck();
    press("char-71", { pointerId: 1 });
    expect(screen.getByTestId("deck-key-preview")).toHaveTextContent("q");
    press("char-77", { pointerId: 2 });
    expect(screen.getByTestId("deck-key-preview")).toHaveTextContent("w");
    // The first finger lifting must not take the second finger's balloon with it.
    release("char-71", { pointerId: 1 });
    expect(screen.getByTestId("deck-key-preview")).toHaveTextContent("w");
    release("char-77", { pointerId: 2 });
    expect(screen.queryByTestId("deck-key-preview")).toBeNull();
  });

  it("takes the balloon down when the layout changes under a held finger", () => {
    renderDeck();
    press("char-71", { pointerId: 1 });
    expect(screen.getByTestId("deck-key-preview")).toHaveTextContent("q");
    // A second thumb arming shift is a layout change, and iOS rebuilds the deck for one.
    press("shift", { pointerId: 2 });
    release("shift", { pointerId: 2 });
    expect(screen.queryByTestId("deck-key-preview")).toBeNull();
    expect(key("char-71")).toHaveAttribute("data-pressed", "true");
  });

  it("leaves the shift double-tap window open across a delete", () => {
    const now = vi.spyOn(performance, "now");
    renderDeck();
    now.mockReturnValue(0);
    tap("shift");
    // On iOS a delete returns before the key handler runs, so it never clears the window.
    tap("delete");
    now.mockReturnValue(SHIFT_DOUBLE_TAP_MS - 1);
    tap("shift");
    expect(key("shift")).toHaveAttribute("data-shift", "locked");
    now.mockRestore();
  });

  it("lights an armed shift and reads its lock state as a tri-state", () => {
    renderDeck();
    expect(key("shift")).toHaveAttribute("data-shift", "off");
    expect(key("shift")).toHaveAttribute("aria-pressed", "false");
    tap("shift");
    expect(key("shift")).toHaveAttribute("data-shift", "on");
    expect(key("shift")).toHaveAttribute("aria-pressed", "mixed");
    expect(key("shift").className).toContain("bg-[rgba(0,122,255,0.42)]");
    tap("shift");
    expect(key("shift")).toHaveAttribute("aria-pressed", "true");
  });

  it("hands typing to the browser's keyboard from the globe's old seat", () => {
    const { onSwitchToNative, onCharacter } = renderDeck();
    const row = [...deck().querySelectorAll("[data-deck-row]")][3]!;
    // Between the page key and the space bar, which is where iOS put the globe.
    expect([...row.children].map((child) => child.getAttribute("aria-label"))).toEqual([
      "Numbers",
      "Switch to the system keyboard",
      "Space",
      "Return",
    ]);
    tap("native");
    expect(onSwitchToNative).toHaveBeenCalledTimes(1);
    expect(onCharacter).not.toHaveBeenCalled();
  });

  it("keeps the switch on every page and out of the shift double-tap window", () => {
    const now = vi.spyOn(performance, "now");
    const { onSwitchToNative } = renderDeck();
    now.mockReturnValue(0);
    tap("shift");
    // The globe did not clear the window either; it returned before the key handler.
    tap("native");
    now.mockReturnValue(SHIFT_DOUBLE_TAP_MS - 1);
    tap("shift");
    expect(key("shift")).toHaveAttribute("data-shift", "locked");
    now.mockRestore();

    tap("page-numbers");
    stubDeckLayout(deck());
    tap("native");
    expect(onSwitchToNative).toHaveBeenCalledTimes(2);
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
    expect(key("space").style.flexGrow).toBe("3.8");
  });

  it("keeps the wider gaps off the number and symbol pages", () => {
    renderDeck();
    tap("page-numbers");
    expect(key("delete").style.marginLeft).toBe("");
    expect(key("char-2e").style.width).toBe("");
  });
});

describe("KeyboardDeck hit areas", () => {
  it("types the key nearest an empty patch of deck", () => {
    const { onCharacter } = renderDeck();
    // The indent left of the home row, which on the iPhone belongs to `a`.
    const a = key("char-61").getBoundingClientRect();
    const at = { clientX: a.left - 10, clientY: (a.top + a.bottom) / 2 };
    press("char-61", at);
    release("char-61", at);
    expect(typed(onCharacter)).toBe("a");
  });

  it("types from the deck's own padding and from the seams between keys", () => {
    const { onCharacter } = renderDeck();
    const q = key("char-71").getBoundingClientRect();
    const midY = (q.top + q.bottom) / 2;
    // Above the top row, inside the deck's top padding.
    press("char-71", { clientX: (q.left + q.right) / 2, clientY: 1 });
    release("char-71", { clientX: (q.left + q.right) / 2, clientY: 1 });
    // Either side of the seam in the gap between q and w.
    const w = key("char-77").getBoundingClientRect();
    const seam = (q.right + w.left) / 2;
    press("char-71", { clientX: seam - 1, clientY: midY });
    release("char-71", { clientX: seam - 1, clientY: midY });
    press("char-77", { clientX: seam + 1, clientY: midY });
    release("char-77", { clientX: seam + 1, clientY: midY });
    expect(typed(onCharacter)).toBe("qqw");
  });

  it("ignores a touch that starts outside the deck", () => {
    const { onCharacter } = renderDeck();
    fireEvent.pointerDown(deck(), { pointerId: 1, clientX: 20, clientY: -5 });
    fireEvent.pointerUp(deck(), { pointerId: 1, clientX: 20, clientY: -5 });
    expect(onCharacter).not.toHaveBeenCalled();
  });
});

describe("KeyboardDeck under fast typing", () => {
  it("keeps every key in a burst that reuses one pointer id", () => {
    const { onCharacter } = renderDeck();
    for (const id of ["char-71", "char-77", "char-65", "char-72"]) tap(id);
    expect(typed(onCharacter)).toBe("qwer");
  });

  it("keeps both keys of a roll whichever finger lifts first", () => {
    const { onCharacter } = renderDeck();
    press("char-71", { pointerId: 1 });
    press("char-77", { pointerId: 2 });
    release("char-77", { pointerId: 2 });
    release("char-71", { pointerId: 1 });
    expect(typed(onCharacter)).toBe("wq");
  });

  it("never loses an edge tap, whichever side of the seam it rolls to", () => {
    const { onCharacter } = renderDeck();
    const q = key("char-71").getBoundingClientRect();
    const w = key("char-77").getBoundingClientRect();
    const midY = (q.top + q.bottom) / 2;
    const seam = (q.right + w.left) / 2;
    // Landing near the right edge and rolling is an ordinary thumb tap. It used to type nothing;
    // now it types whichever key the finger is over, which is never nothing.
    press("char-71", { clientX: q.right - 1, clientY: midY });
    moveTo(seam - 1, midY);
    release("char-71", { clientX: seam - 1, clientY: midY });
    press("char-71", { clientX: q.right - 1, clientY: midY });
    moveTo(seam + 1, midY);
    release("char-77", { clientX: seam + 1, clientY: midY });
    expect(typed(onCharacter)).toBe("qw");
  });

  it("recovers a pointer id whose release never arrived", () => {
    const { onCharacter } = renderDeck();
    // One missed pointerup would otherwise poison that id for the life of the deck, and iOS hands
    // the same ids out again, so every later touch on it would vanish silently.
    press("char-71", { pointerId: 1 });
    press("char-77", { pointerId: 1 });
    release("char-77", { pointerId: 1 });
    expect(typed(onCharacter)).toBe("w");
  });
});
