import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_DECK_SHARE,
  useDeckHeight,
  validDeckShare,
} from "@/features/desktop-viewer/trackpad/deckHeightPreference";
import { TRACKPAD_DECK_MIN_HEIGHT, trackpadDeckHeight } from "@/features/desktop-viewer/trackpad/trackpadConstants";

beforeEach(() => {
  useDeckHeight.getState().resetDeckShare();
});

describe("trackpad deck height", () => {
  it("keeps only a share the slider could set", () => {
    expect(validDeckShare(0.5)).toBe(0.5);
    expect(validDeckShare(0.9)).toBe(DEFAULT_DECK_SHARE);
    expect(validDeckShare(0.05)).toBe(DEFAULT_DECK_SHARE);
    expect(validDeckShare("0.5")).toBe(DEFAULT_DECK_SHARE);
    expect(validDeckShare(Number.NaN)).toBe(DEFAULT_DECK_SHARE);
  });

  it("sets and resets the share", () => {
    useDeckHeight.getState().setDeckShare(0.24);
    expect(useDeckHeight.getState().deckShare).toBe(0.24);
    useDeckHeight.getState().resetDeckShare();
    expect(useDeckHeight.getState().deckShare).toBe(DEFAULT_DECK_SHARE);
  });

  it("is that share of the viewer, never below the floor", () => {
    expect(trackpadDeckHeight(800, 0.5)).toBe(400);
    expect(trackpadDeckHeight(800, DEFAULT_DECK_SHARE)).toBe(304);
    expect(trackpadDeckHeight(400, 0.2)).toBe(TRACKPAD_DECK_MIN_HEIGHT);
  });
});
