import { describe, expect, it } from "vitest";
import { keyboardInset, typesText } from "./keyboardInset";

describe("keyboardInset", () => {
  it("gives back the strip a keyboard covers", () => {
    // The layout viewport does not shrink for a keyboard; the visual one does.
    expect(keyboardInset({
      layoutHeight: 844,
      viewportHeight: 508,
      viewportOffsetTop: 0,
      typing: true,
    })).toBe(336);
  });

  it("counts a panned viewport as covered too", () => {
    // iOS pans to keep the caret in sight, which moves the covered strip without resizing it.
    expect(keyboardInset({
      layoutHeight: 844,
      viewportHeight: 508,
      viewportOffsetTop: 40,
      typing: true,
    })).toBe(296);
  });

  it("ignores a shrunken viewport with nothing typing into it", () => {
    // A pinch-zoom looks identical and means the opposite: the reader panned away on purpose.
    expect(keyboardInset({
      layoutHeight: 844,
      viewportHeight: 508,
      viewportOffsetTop: 0,
      typing: false,
    })).toBe(0);
  });

  it("ignores a difference too small to be a keyboard", () => {
    expect(keyboardInset({
      layoutHeight: 844,
      viewportHeight: 820,
      viewportOffsetTop: 0,
      typing: true,
    })).toBe(0);
  });
});

describe("typesText", () => {
  it("recognizes the fields a phone raises a keyboard for", () => {
    // xterm types through a hidden textarea, which is why the terminal counts at all.
    expect(typesText(document.createElement("textarea"))).toBe(true);
    expect(typesText(document.createElement("input"))).toBe(true);
    expect(typesText(document.createElement("div"))).toBe(false);
    expect(typesText(null)).toBe(false);
  });
});
