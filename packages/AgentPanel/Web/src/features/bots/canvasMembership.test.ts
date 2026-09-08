import { beforeEach, describe, expect, it } from "vitest";
import { loadDetachedBotIds, storeDetachedBotIds, withBotDetached } from "./canvasMembership";

const STORAGE_KEY = "agent-panel.bot-canvas.detached";

describe("canvas membership", () => {
  beforeEach(() => localStorage.clear());

  it("shows every Bot until one is taken off", () => {
    expect(loadDetachedBotIds()).toEqual(new Set());
  });

  it("remembers the Bots taken off the canvas", () => {
    storeDetachedBotIds(new Set(["bot-1", "bot-2"]));
    expect(loadDetachedBotIds()).toEqual(new Set(["bot-1", "bot-2"]));
  });

  it("keeps the canvas whole rather than trusting a value it cannot read", () => {
    localStorage.setItem(STORAGE_KEY, "{}");
    expect(loadDetachedBotIds()).toEqual(new Set());

    localStorage.setItem(STORAGE_KEY, "not json");
    expect(loadDetachedBotIds()).toEqual(new Set());

    // A half-readable list keeps the entries it can read: the alternative is putting a Bot back on
    // someone's canvas because an unrelated entry was corrupt.
    localStorage.setItem(STORAGE_KEY, JSON.stringify(["bot-1", 7, "", null]));
    expect(loadDetachedBotIds()).toEqual(new Set(["bot-1"]));
  });

  it("answers an edit with a new set, because React compares by identity", () => {
    const ids = new Set(["bot-1"]);
    const added = withBotDetached(ids, "bot-2", true);
    expect(added).not.toBe(ids);
    expect(added).toEqual(new Set(["bot-1", "bot-2"]));
    expect(withBotDetached(added, "bot-1", false)).toEqual(new Set(["bot-2"]));
  });
});
