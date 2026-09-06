import { describe, expect, it } from "vitest";
import {
  COMPACT_LANDSCAPE_DECK,
  PORTRAIT_DECK,
  characterPreviewLayout,
  characterPreviewPath,
  deckMetricsForViewportHeight,
} from "./keyboardDeckMetrics";
import {
  INITIAL_DECK_STATE,
  deckKeyLabel,
  deckRows,
  handleDeckKey,
  handleShiftTap,
  isSpecialKey,
  keyWidthWeight,
  type DeckKey,
  type KeyboardDeckState,
} from "./keyboardDeckModel";

const character = (value: string): DeckKey => ({ kind: "character", value });
const shifted: KeyboardDeckState = { page: "alphabet", shift: "on" };

describe("keyboard deck layout", () => {
  it("lays the three pages out the way the iPhone does", () => {
    const alphabet = deckRows(INITIAL_DECK_STATE);
    expect(alphabet.map((row) => row.length)).toEqual([10, 9, 9, 4]);
    expect(alphabet[0]!.map((key) => deckKeyLabel(key, INITIAL_DECK_STATE)).join(""))
      .toBe("qwertyuiop");
    expect(alphabet[2]![0]).toEqual({ kind: "shift" });
    expect(alphabet[2]!.at(-1)).toEqual({ kind: "delete" });
    // The globe's seat, holding the only other input mode a page has: the browser's own keyboard.
    expect(alphabet[3]).toEqual([
      { kind: "page", page: "numbers" }, { kind: "native" }, { kind: "space" }, { kind: "return" },
    ]);
    for (const page of ["numbers", "symbols"] as const) {
      expect(deckRows({ page, shift: "off" })[3]![1]).toEqual({ kind: "native" });
    }

    const numbers = deckRows({ page: "numbers", shift: "off" });
    expect(numbers[0]!.map((key) => deckKeyLabel(key, INITIAL_DECK_STATE)).join(""))
      .toBe("1234567890");
    expect(numbers[2]![0]).toEqual({ kind: "page", page: "symbols" });

    const symbols = deckRows({ page: "symbols", shift: "off" });
    expect(symbols[1]!.map((key) => deckKeyLabel(key, INITIAL_DECK_STATE)).join(""))
      .toBe("_\\|~<>€£¥•");
  });

  it("shifts only the alphabet page, and only its labels", () => {
    expect(deckKeyLabel(character("q"), shifted)).toBe("Q");
    expect(deckKeyLabel(character("$"), { page: "numbers", shift: "on" })).toBe("$");
    expect(deckKeyLabel({ kind: "shift" }, shifted)).toBe("⇧");
    expect(deckKeyLabel({ kind: "shift" }, { page: "alphabet", shift: "locked" })).toBe("⇪");
    // Always the plain glyph: the Mac does not report a field's return-key type.
    expect(deckKeyLabel({ kind: "return" }, INITIAL_DECK_STATE)).toBe("↵");
  });

  it("clears an armed shift on typing but not on delete", () => {
    expect(handleDeckKey(shifted, character("q")))
      .toEqual({ state: { page: "alphabet", shift: "off" }, output: "Q" });
    expect(handleDeckKey(shifted, { kind: "space" }))
      .toEqual({ state: { page: "alphabet", shift: "off" }, output: " " });
    expect(handleDeckKey(shifted, { kind: "return" }))
      .toEqual({ state: { page: "alphabet", shift: "off" }, output: "\n" });
    expect(handleDeckKey(shifted, { kind: "delete" })).toEqual({ state: shifted, output: null });
  });

  it("keeps a locked shift across keys", () => {
    const locked: KeyboardDeckState = { page: "alphabet", shift: "locked" };
    const result = handleDeckKey(locked, character("q"));
    expect(result).toEqual({ state: locked, output: "Q" });
  });

  it("cycles shift off, on, locked only on a double tap", () => {
    const off = INITIAL_DECK_STATE;
    const on = handleShiftTap(off, false);
    expect(on.shift).toBe("on");
    expect(handleShiftTap(on, false).shift).toBe("off");
    expect(handleShiftTap(on, true).shift).toBe("locked");
    expect(handleShiftTap({ page: "alphabet", shift: "locked" }, true).shift).toBe("off");
  });

  it("drops shift when leaving the alphabet page and keeps it on returning", () => {
    expect(handleDeckKey(shifted, { kind: "page", page: "numbers" }).state)
      .toEqual({ page: "numbers", shift: "off" });
    expect(handleDeckKey(shifted, { kind: "page", page: "alphabet" }).state)
      .toEqual({ page: "alphabet", shift: "on" });
  });

  it("weights keys the way the Swift width constraints do", () => {
    expect(keyWidthWeight({ kind: "space" })).toBe(3.4);
    expect(keyWidthWeight({ kind: "return" })).toBe(1.65);
    expect(keyWidthWeight({ kind: "page", page: "numbers" })).toBe(1.35);
    expect(keyWidthWeight({ kind: "shift" })).toBe(1.25);
    expect(keyWidthWeight({ kind: "delete" })).toBe(1.25);
    expect(keyWidthWeight(character("q"))).toBe(0.88);
  });

  it("treats only characters and the space bar as regular keys", () => {
    expect(isSpecialKey(character("q"))).toBe(false);
    expect(isSpecialKey({ kind: "space" })).toBe(false);
    expect(isSpecialKey({ kind: "shift" })).toBe(true);
    expect(isSpecialKey({ kind: "return" })).toBe(true);
  });
});

describe("keyboard deck metrics", () => {
  it("keeps the deck height the rows and padding actually add up to", () => {
    for (const metrics of [PORTRAIT_DECK, COMPACT_LANDSCAPE_DECK]) {
      const rows = 4 * metrics.keycapHeight + 3 * metrics.verticalRowGap;
      expect(rows + metrics.topDeckPadding + metrics.bottomDeckPadding).toBe(metrics.deckHeight);
    }
    expect(PORTRAIT_DECK.deckHeight).toBe(236);
    expect(COMPACT_LANDSCAPE_DECK.deckHeight).toBe(201);
  });

  it("keeps 44pt targets on a short viewport", () => {
    expect(deckMetricsForViewportHeight(844)).toBe(PORTRAIT_DECK);
    expect(deckMetricsForViewportHeight(390)).toBe(COMPACT_LANDSCAPE_DECK);
    expect(COMPACT_LANDSCAPE_DECK.keycapHeight).toBe(44);
  });
});

describe("character preview geometry", () => {
  it("centres the balloon over an inner key", () => {
    const layout = characterPreviewLayout({ left: 150, top: 100, width: 32 }, 390);
    expect(layout.width).toBe(60);
    expect(layout.height).toBe(67);
    expect(layout.left + layout.width / 2).toBeCloseTo(166, 5);
    expect(layout.left + layout.tipX).toBeCloseTo(166, 5);
    // Nine points of tail, minus the three it spends overlapping the key it points at.
    expect(layout.top + layout.height).toBe(103);
  });

  it("holds the balloon inside the deck and moves the tail instead", () => {
    const left = characterPreviewLayout({ left: 7, top: 100, width: 32 }, 390);
    expect(left.left).toBe(3);
    expect(left.left + left.tipX).toBeCloseTo(23, 5);

    const right = characterPreviewLayout({ left: 351, top: 100, width: 32 }, 390);
    expect(right.left + right.width).toBe(387);
    expect(right.left + right.tipX).toBeCloseTo(367, 5);
  });

  it("clamps the tail onto the bubble's flat edge at the very corner", () => {
    const layout = characterPreviewLayout({ left: 0, top: 100, width: 32 }, 390);
    expect(layout.tipX).toBe(19);
    expect(layout.left + layout.tipX).toBeGreaterThan(16);
  });

  it("draws a closed outline whose tail sits at the tip", () => {
    const path = characterPreviewPath(60, 67, 30);
    expect(path.startsWith("M 11 0")).toBe(true);
    expect(path).toContain("L 38 58");
    expect(path).toContain("L 30 67");
    expect(path).toContain("L 22 58");
    expect(path.endsWith("Z")).toBe(true);
  });
});
