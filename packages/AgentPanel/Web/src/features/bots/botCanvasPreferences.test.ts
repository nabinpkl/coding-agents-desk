import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_CARD_HEIGHT,
  DEFAULT_CARD_WIDTH,
  MAX_CARD_HEIGHT,
  MAX_CARD_WIDTH,
  MIN_CARD_HEIGHT,
  MIN_CARD_WIDTH,
  clampCardHeight,
  clampCardWidth,
  loadBotCardSizes,
  storeBotCardSizes,
} from "./botCanvasPreferences";

const STORAGE_KEY = "agent-panel.bot-canvas.card-sizes";

describe("bot canvas preferences", () => {
  beforeEach(() => localStorage.clear());

  it("knows nothing before a card has been resized, so every card takes the default", () => {
    expect(loadBotCardSizes()).toEqual({});
  });

  it("remembers a size per Bot, which is what makes the canvas tiled rather than uniform", () => {
    storeBotCardSizes({
      "bot-wide": { width: 900, height: 910 },
      "bot-narrow": { width: 340, height: 400 },
    });
    expect(loadBotCardSizes()).toEqual({
      "bot-wide": { width: 900, height: 910 },
      "bot-narrow": { width: 340, height: 400 },
    });
  });

  it("holds a size inside the usable range before storing it", () => {
    storeBotCardSizes({ "bot-1": { width: 1, height: 1 } });
    expect(loadBotCardSizes()["bot-1"]).toEqual({
      width: MIN_CARD_WIDTH,
      height: MIN_CARD_HEIGHT,
    });

    storeBotCardSizes({ "bot-1": { width: 99999, height: 99999 } });
    expect(loadBotCardSizes()["bot-1"]).toEqual({
      width: MAX_CARD_WIDTH,
      height: MAX_CARD_HEIGHT,
    });
  });

  it("judges each dimension on its own, so one bad number does not throw away the other", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ "bot-1": { width: 700, height: "tall" } }));
    expect(loadBotCardSizes()["bot-1"]).toEqual({ width: 700, height: DEFAULT_CARD_HEIGHT });

    localStorage.setItem(STORAGE_KEY, JSON.stringify({ "bot-1": { width: null, height: 700 } }));
    expect(loadBotCardSizes()["bot-1"]).toEqual({ width: DEFAULT_CARD_WIDTH, height: 700 });
  });

  it("falls back to knowing nothing rather than trusting what it cannot read", () => {
    localStorage.setItem(STORAGE_KEY, "not json");
    expect(loadBotCardSizes()).toEqual({});

    localStorage.setItem(STORAGE_KEY, JSON.stringify(["bot-1"]));
    expect(loadBotCardSizes()).toEqual({});
  });

  it("keeps a card inside the row it sits in", () => {
    // A 900px card asked for in a 500px canvas is 500 wide, which is what gives a narrow panel one
    // card per row without any breakpoint knowing about it.
    expect(clampCardWidth(900, 500)).toBe(500);
    // The canvas wins over the floor too: being inside the page matters more than being legible.
    expect(clampCardWidth(900, 200)).toBe(200);
    // Unmeasured, only the absolute range applies.
    expect(clampCardWidth(900, 0)).toBe(900);
  });

  it("lets a card be taller than any window, because the canvas scrolls", () => {
    // The screen is not a bound on height. A Bot with a long transcript is exactly the case for a
    // card taller than the window, and the cards below it are a scroll away rather than lost.
    expect(clampCardHeight(4200)).toBe(4200);
    // The ends of its own range still hold: below the floor the grip itself would be clipped away
    // by the card, and above the ceiling a stored number is corrupt rather than chosen.
    expect(clampCardHeight(10)).toBe(MIN_CARD_HEIGHT);
    expect(clampCardHeight(99999)).toBe(MAX_CARD_HEIGHT);
  });
});
