import { afterEach, describe, expect, it, vi } from "vitest";
import { KEEP_IN_SIGHT_ATTRIBUTE, keepTypingInSight, keyboardInset, typesText } from "@/app/page/keyboardInset";

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

describe("keepTypingInSight", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  /** A scroller with a field in it, and a hand on the observer the helper installs. */
  function setUp() {
    let resized = (): void => {};
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: () => void) { resized = callback; }
      observe() {}
      disconnect() { resized = () => {}; }
    });
    const scroller = document.createElement("main");
    const field = document.createElement("textarea");
    scroller.append(field);
    const outside = document.createElement("input");
    document.body.append(scroller, outside);
    for (const one of [field, outside]) one.scrollIntoView = vi.fn();
    return { scroller, field, outside, resize: () => resized() };
  }

  it("scrolls the focused field back into sight when its scroller shrinks", () => {
    // A lane's composer sits at the foot of a column taller than a phone with its keyboard up.
    const { scroller, field, resize } = setUp();
    keepTypingInSight(scroller);
    field.focus();
    resize();
    expect(field.scrollIntoView).toHaveBeenCalledWith({ block: "nearest", inline: "nearest" });
  });

  it("brings a marked region into sight whole, not just the field inside it", () => {
    // A terminal is typed into through xterm's hidden field; its screen and key rail are the pane.
    const { scroller, field, resize } = setUp();
    const pane = document.createElement("section");
    pane.setAttribute(KEEP_IN_SIGHT_ATTRIBUTE, "");
    pane.scrollIntoView = vi.fn();
    scroller.append(pane);
    pane.append(field);
    keepTypingInSight(scroller);
    field.focus();
    resize();
    expect(pane.scrollIntoView).toHaveBeenCalledWith({ block: "nearest", inline: "nearest" });
    expect(field.scrollIntoView).not.toHaveBeenCalled();
  });

  it("leaves a field outside the scroller, and stops once removed", () => {
    const { scroller, field, outside, resize } = setUp();
    const keeping = keepTypingInSight(scroller);
    outside.focus();
    resize();
    expect(outside.scrollIntoView).not.toHaveBeenCalled();
    keeping.remove();
    field.focus();
    resize();
    expect(field.scrollIntoView).not.toHaveBeenCalled();
  });
});
