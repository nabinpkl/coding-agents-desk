import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_CARD_HEIGHT,
  DEFAULT_CARD_WIDTH,
  MAX_CARD_HEIGHT,
  MAX_CARD_WIDTH,
  MIN_CARD_HEIGHT,
  MIN_CARD_WIDTH,
  botCanvasOrderOf,
  clampCardHeight,
  clampCardWidth,
  loadBotCanvasOrder,
  loadCanvasOpenKeys,
  loadCanvasRoomMode,
  loadCanvasScroll,
  loadDetachedBotIds,
  loadDetachedSessionKeys,
  loadHiddenMachines,
  loadSessionCardSizes,
  moveInOrder,
  orderBotsForCanvas,
  storeBotCanvasOrder,
  storeCanvasOpenKeys,
  storeCanvasRoomMode,
  storeCanvasScroll,
  storeDetachedBotIds,
  storeDetachedSessionKeys,
  storeHiddenMachines,
  storeSessionCardSizes,
} from "@/features/bots/botCanvasPreferences";

const STORAGE_KEY = "agent-panel.bot-canvas.session-sizes";
const OPEN_SESSIONS_STORAGE_KEY = "agent-panel.bot-canvas.open-session";
const SCROLL_STORAGE_KEY = "agent-panel.bot-canvas.scroll";
const OFF_CANVAS_SESSIONS_KEY = "agent-panel.bot-canvas.off-canvas-sessions";
const OFF_CANVAS_BOTS_KEY = "agent-panel.bot-canvas.off-canvas-bots";

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

describe("which sessions the canvas has open", () => {
  beforeEach(() => localStorage.clear());

  it("knows nothing before a card has been opened", () => {
    expect(loadCanvasOpenKeys()).toEqual(new Set());
  });

  it("remembers every open card, which is the whole point of holding a set", () => {
    storeCanvasOpenKeys(new Set(["claude:a", "codex:b"]));
    expect(loadCanvasOpenKeys()).toEqual(new Set(["claude:a", "codex:b"]));
  });

  it("forgets the last card rather than storing an empty list", () => {
    storeCanvasOpenKeys(new Set(["claude:a"]));
    storeCanvasOpenKeys(new Set());
    expect(localStorage.getItem(OPEN_SESSIONS_STORAGE_KEY)).toBeNull();
  });

  it("drops an entry that is not shaped like a session key, rather than opening nothing at all", () => {
    // A stale or hand-edited value must not become a lookup for a card that could never exist, and
    // one bad entry must not cost the reader the cards beside it.
    localStorage.setItem(OPEN_SESSIONS_STORAGE_KEY, JSON.stringify(["claude:a", "nocolon", 7]));
    expect(loadCanvasOpenKeys()).toEqual(new Set(["claude:a"]));
  });

  it("opens nothing on the single key it used to write, which is what upgrades a reader", () => {
    // The name is reused rather than changed, so the value under it is the old bare string until
    // the first write replaces it.
    localStorage.setItem(OPEN_SESSIONS_STORAGE_KEY, "claude:a");
    expect(loadCanvasOpenKeys()).toEqual(new Set());
  });
});

describe("how far the canvas is scrolled", () => {
  beforeEach(() => localStorage.clear());

  it("opens at the left edge before the canvas has been scrolled", () => {
    expect(loadCanvasScroll()).toEqual({ left: 0, top: 0 });
  });

  it("remembers both axes, because a tall card scrolls the canvas down as well as along", () => {
    storeCanvasScroll({ left: 1840, top: 96 });
    expect(loadCanvasScroll()).toEqual({ left: 1840, top: 96 });
  });

  it("forgets the left edge rather than storing the number that means the default", () => {
    storeCanvasScroll({ left: 1840, top: 96 });
    storeCanvasScroll({ left: 0, top: 0 });
    expect(localStorage.getItem(SCROLL_STORAGE_KEY)).toBeNull();
  });

  it("judges each axis on its own, so one bad number does not throw away the other", () => {
    localStorage.setItem(SCROLL_STORAGE_KEY, JSON.stringify({ left: 1840, top: "down a bit" }));
    expect(loadCanvasScroll()).toEqual({ left: 1840, top: 0 });
  });

  it("keeps an offset behind the canvas's own start, which the room around it makes a place", () => {
    // It used to refuse this, on the grounds that no scroller can be at a negative offset. The
    // zoom mode's room made it a real one: the offset is measured from the canvas, not from the
    // scroller, so parking the canvas lower and further right than it starts stores a number
    // behind its start. Anything the canvas cannot actually reach is clamped by the browser.
    localStorage.setItem(SCROLL_STORAGE_KEY, JSON.stringify({ left: -400, top: 40 }));
    expect(loadCanvasScroll()).toEqual({ left: -400, top: 40 });
  });

  it("opens at the left edge rather than trusting a value it cannot read", () => {
    localStorage.setItem(SCROLL_STORAGE_KEY, "{not json");
    expect(loadCanvasScroll()).toEqual({ left: 0, top: 0 });
  });
});

describe("whether the fitted canvas has room around it", () => {
  beforeEach(() => localStorage.clear());

  it("is off until a reader asks for it, because room an axis did not need reads as drift", () => {
    expect(loadCanvasRoomMode()).toBe(false);
    storeCanvasRoomMode(true);
    expect(loadCanvasRoomMode()).toBe(true);
  });

  it("forgets it rather than storing the value that means the default", () => {
    storeCanvasRoomMode(true);
    storeCanvasRoomMode(false);
    expect(localStorage.getItem("agent-panel.bot-canvas.room")).toBeNull();
  });
});

describe("what the canvas has been told to hide", () => {
  beforeEach(() => localStorage.clear());

  it("hides nothing before anything has been taken off the canvas", () => {
    expect(loadDetachedBotIds()).toEqual(new Set());
    expect(loadDetachedSessionKeys()).toEqual(new Set());
  });

  it("remembers what is hidden, so a reload does not undo the tidying", () => {
    storeDetachedBotIds(new Set(["bot-a", "bot-b"]));
    storeDetachedSessionKeys(new Set(["claude:a", "codex:b"]));
    expect(loadDetachedBotIds()).toEqual(new Set(["bot-a", "bot-b"]));
    expect(loadDetachedSessionKeys()).toEqual(new Set(["claude:a", "codex:b"]));
  });

  it("keeps the two apart, so putting a Bot back does not show its hidden sessions", () => {
    storeDetachedBotIds(new Set(["bot-a"]));
    storeDetachedSessionKeys(new Set(["claude:a"]));
    storeDetachedBotIds(new Set());
    expect(loadDetachedSessionKeys()).toEqual(new Set(["claude:a"]));
  });

  it("forgets the last hidden one rather than storing an empty list", () => {
    storeDetachedBotIds(new Set(["bot-a"]));
    storeDetachedSessionKeys(new Set(["claude:a"]));
    storeDetachedBotIds(new Set());
    storeDetachedSessionKeys(new Set());
    expect(localStorage.getItem(OFF_CANVAS_BOTS_KEY)).toBeNull();
    expect(localStorage.getItem(OFF_CANVAS_SESSIONS_KEY)).toBeNull();
  });

  it("drops an entry it cannot read rather than hiding nothing at all", () => {
    // The dangerous direction for this store is the one where a bad value HIDES something, so an
    // unreadable entry is dropped on its own and the readable ones beside it still stand.
    localStorage.setItem(OFF_CANVAS_SESSIONS_KEY, JSON.stringify(["claude:a", "nocolon", 7]));
    localStorage.setItem(OFF_CANVAS_BOTS_KEY, JSON.stringify(["bot-a", "", 7]));
    expect(loadDetachedSessionKeys()).toEqual(new Set(["claude:a"]));
    expect(loadDetachedBotIds()).toEqual(new Set(["bot-a"]));
  });

  it("shows everything again rather than trusting a value it cannot read", () => {
    localStorage.setItem(OFF_CANVAS_BOTS_KEY, "{not json");
    localStorage.setItem(OFF_CANVAS_SESSIONS_KEY, "{not json");
    expect(loadDetachedBotIds()).toEqual(new Set());
    expect(loadDetachedSessionKeys()).toEqual(new Set());
  });
});

const HIDDEN_MACHINES_KEY = "agent-panel.bot-canvas.hidden-machines";

describe("the machines the canvas is showing", () => {
  beforeEach(() => localStorage.clear());

  it("remembers a hidden machine across a reload", () => {
    storeHiddenMachines(new Set(["oracle"]));
    expect(loadHiddenMachines()).toEqual(new Set(["oracle"]));
  });

  it("can hide this machine, whose key is the empty string", () => {
    // The one entry a length check would silently drop. `machineKey` gives the panel's own sidecar
    // "" precisely because no declared peer can have it, and hiding it to look at a peer alone is
    // exactly what a reader would do.
    storeHiddenMachines(new Set([""]));
    expect(loadHiddenMachines()).toEqual(new Set([""]));
  });

  it("forgets the last one rather than storing an empty list", () => {
    storeHiddenMachines(new Set(["oracle"]));
    storeHiddenMachines(new Set());
    expect(localStorage.getItem(HIDDEN_MACHINES_KEY)).toBeNull();
  });

  it("shows every machine again rather than trusting a value it cannot read", () => {
    // The dangerous direction here is the one where a bad value HIDES cards, so anything
    // unreadable means "show everything" and an unreadable entry beside good ones is dropped alone.
    localStorage.setItem(HIDDEN_MACHINES_KEY, "{not json");
    expect(loadHiddenMachines()).toEqual(new Set());
    localStorage.setItem(HIDDEN_MACHINES_KEY, JSON.stringify(["oracle", 7, null]));
    expect(loadHiddenMachines()).toEqual(new Set(["oracle"]));
  });
});
