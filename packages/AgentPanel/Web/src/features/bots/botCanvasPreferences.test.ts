import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_CARD_HEIGHT,
  DEFAULT_CARD_WIDTH,
  MAX_CARD_HEIGHT,
  CAROUSEL_CANVAS_WIDTH,
  MAX_CARD_WIDTH,
  MIN_CARD_HEIGHT,
  MIN_CARD_WIDTH,
  botCanvasOrderOf,
  clampCardHeight,
  clampCardWidth,
  loadBotCanvasOrder,
  loadSessionCardSizes,
  moveInOrder,
  orderBotsForCanvas,
  storeBotCanvasOrder,
  storeSessionCardSizes,
} from "./botCanvasPreferences";

const STORAGE_KEY = "agent-panel.bot-canvas.session-sizes";

describe("session card sizes", () => {
  beforeEach(() => localStorage.clear());

  it("knows nothing before a session has been resized, so every one takes the default", () => {
    expect(loadSessionCardSizes()).toEqual({});
  });

  it("remembers a size per session, which is what makes a Bot's strip its own shape", () => {
    storeSessionCardSizes(
      {
        "claude:wide": { width: 900, height: 910 },
        "codex:narrow": { width: 340, height: 400 },
      },
      ["claude:wide", "codex:narrow"],
    );
    expect(loadSessionCardSizes()).toEqual({
      "claude:wide": { width: 900, height: 910 },
      "codex:narrow": { width: 340, height: 400 },
    });
  });

  it("holds a size inside the usable range before storing it", () => {
    storeSessionCardSizes({ "claude:s1": { width: 1, height: 1 } }, ["claude:s1"]);
    expect(loadSessionCardSizes()["claude:s1"]).toEqual({
      width: MIN_CARD_WIDTH,
      height: MIN_CARD_HEIGHT,
    });

    storeSessionCardSizes({ "claude:s1": { width: 99999, height: 99999 } }, ["claude:s1"]);
    expect(loadSessionCardSizes()["claude:s1"]).toEqual({
      width: MAX_CARD_WIDTH,
      height: MAX_CARD_HEIGHT,
    });
  });

  it("judges each dimension on its own, so one bad number does not throw away the other", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ "claude:s1": { width: 700, height: "tall" } }));
    expect(loadSessionCardSizes()["claude:s1"]).toEqual({ width: 700, height: DEFAULT_CARD_HEIGHT });

    localStorage.setItem(STORAGE_KEY, JSON.stringify({ "claude:s1": { width: null, height: 700 } }));
    expect(loadSessionCardSizes()["claude:s1"]).toEqual({ width: DEFAULT_CARD_WIDTH, height: 700 });
  });

  it("falls back to knowing nothing rather than trusting what it cannot read", () => {
    localStorage.setItem(STORAGE_KEY, "not json");
    expect(loadSessionCardSizes()).toEqual({});

    localStorage.setItem(STORAGE_KEY, JSON.stringify(["bot-1"]));
    expect(loadSessionCardSizes()).toEqual({});
  });

  it("lets a card be wider than any panel, because the strip scrolls sideways", () => {
    // The panel is not a bound on width. The cards are one strip, so a card wider than the panel is
    // a card you asked to see more of, and nothing wraps out of view to make room for it.
    expect(clampCardWidth(2400)).toBe(2400);
    // The ends of its own range still hold.
    expect(clampCardWidth(10)).toBe(MIN_CARD_WIDTH);
    expect(clampCardWidth(99999)).toBe(MAX_CARD_WIDTH);
  });

  it("gives up on side by side below two cards' worth of canvas", () => {
    // The threshold is a display decision the canvas makes, not a width any card is stored at.
    expect(CAROUSEL_CANVAS_WIDTH).toBe(MIN_CARD_WIDTH * 2);
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

describe("bot canvas order", () => {
  beforeEach(() => localStorage.clear());

  const bots = [{ botId: "a" }, { botId: "b" }, { botId: "c" }];

  it("leaves the roster alone until the canvas has been arranged", () => {
    expect(loadBotCanvasOrder()).toEqual([]);
    expect(botCanvasOrderOf(orderBotsForCanvas(bots, []))).toEqual(["a", "b", "c"]);
  });

  it("stands the arranged Bots in the order they were put in", () => {
    storeBotCanvasOrder(["c", "a", "b"]);
    expect(botCanvasOrderOf(orderBotsForCanvas(bots, loadBotCanvasOrder()))).toEqual(["c", "a", "b"]);
  });

  it("puts a Bot the arrangement has never seen at the end", () => {
    // On the right, where a new thing belongs, rather than in the middle of a strip you arranged.
    expect(botCanvasOrderOf(orderBotsForCanvas(bots, ["c"]))).toEqual(["c", "a", "b"]);
  });

  it("ignores an id the canvas no longer knows rather than losing the rest", () => {
    // Not pruned on write either, so a Bot taken off the canvas and put back keeps its place.
    expect(botCanvasOrderOf(orderBotsForCanvas(bots, ["b", "gone", "a"]))).toEqual(["b", "a", "c"]);
  });

  it("refuses an order it cannot read", () => {
    localStorage.setItem("agent-panel.bot-canvas.order", JSON.stringify({ a: 1 }));
    expect(loadBotCanvasOrder()).toEqual([]);
    localStorage.setItem("agent-panel.bot-canvas.order", JSON.stringify(["a", 7, "b"]));
    expect(loadBotCanvasOrder()).toEqual(["a", "b"]);
  });

  it("lifts one entry out and puts it back where it was dropped", () => {
    expect(moveInOrder(["a", "b", "c", "d"], 0, 2)).toEqual(["b", "c", "a", "d"]);
    expect(moveInOrder(["a", "b", "c", "d"], 3, 1)).toEqual(["a", "d", "b", "c"]);
    // A move to where it already is, or off the end, changes nothing.
    expect(moveInOrder(["a", "b"], 1, 1)).toEqual(["a", "b"]);
    expect(moveInOrder(["a", "b"], 0, 5)).toEqual(["a", "b"]);
  });
});

describe("pruning session sizes", () => {
  beforeEach(() => localStorage.clear());

  it("drops sessions no longer on the canvas as it writes", () => {
    // Sessions are not bounded the way Bots are -- a project here holds hundreds -- so a store that
    // only ever grew would carry a size for every session ever opened.
    storeSessionCardSizes(
      { "claude:s1": { width: 700, height: 900 }, "claude:gone": { width: 400, height: 400 } },
      ["claude:s1"],
    );
    expect(Object.keys(loadSessionCardSizes())).toEqual(["claude:s1"]);
  });

  it("writes nothing when nothing on the canvas matches", () => {
    storeSessionCardSizes({ "claude:s1": { width: 700, height: 900 } }, []);
    expect(loadSessionCardSizes()).toEqual({});
  });
});
