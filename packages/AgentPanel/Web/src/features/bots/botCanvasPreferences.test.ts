import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_OPEN_CARD_HEIGHT,
  MAX_OPEN_CARD_HEIGHT,
  MIN_OPEN_CARD_HEIGHT,
  clampOpenCardHeight,
  loadOpenCardHeight,
  storeOpenCardHeight,
} from "./botCanvasPreferences";

const STORAGE_KEY = "agent-panel.bot-canvas.open-card-height";

describe("bot canvas preferences", () => {
  beforeEach(() => localStorage.clear());

  it("opens at the default height before a card has been resized", () => {
    expect(loadOpenCardHeight()).toBe(DEFAULT_OPEN_CARD_HEIGHT);
  });

  it("restores a height a drag committed", () => {
    storeOpenCardHeight(910);
    expect(loadOpenCardHeight()).toBe(910);
  });

  it("holds a height inside the usable range before storing it", () => {
    storeOpenCardHeight(1);
    expect(loadOpenCardHeight()).toBe(MIN_OPEN_CARD_HEIGHT);

    storeOpenCardHeight(99999);
    expect(loadOpenCardHeight()).toBe(MAX_OPEN_CARD_HEIGHT);
  });

  it("falls back to the default rather than trusting a value it cannot read", () => {
    localStorage.setItem(STORAGE_KEY, "tall");
    expect(loadOpenCardHeight()).toBe(DEFAULT_OPEN_CARD_HEIGHT);

    localStorage.setItem(STORAGE_KEY, String(MAX_OPEN_CARD_HEIGHT + 1));
    expect(loadOpenCardHeight()).toBe(DEFAULT_OPEN_CARD_HEIGHT);
  });

  it("keeps a card inside the window it is being dragged in", () => {
    // 85% of a 900px window, not the 1200 asked for: a card taller than the screen buries the
    // cards under it behind a whole session.
    expect(clampOpenCardHeight(1200, 900)).toBe(765);
    // The floor still wins on a short window, because a card below it holds no readable session.
    expect(clampOpenCardHeight(1200, 300)).toBe(MIN_OPEN_CARD_HEIGHT);
    // With no window to measure, only the absolute range applies.
    expect(clampOpenCardHeight(1200)).toBe(1200);
  });
});
