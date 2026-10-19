import { afterEach, describe, expect, it, vi } from "vitest";
import {
  installKeyboardInset,
  KEEP_IN_SIGHT_ATTRIBUTE,
  keepTypingInSight,
  keyboardInset,
  showsKeyboardBar,
  typesText,
} from "@/app/page/keyboardInset";
import { keyboardBarSnapshot } from "@/features/keyboard/keyboardBarState";

describe("keyboardInset", () => {
  it("gives back the strip a keyboard covers", () => {
    // The layout viewport does not shrink for a keyboard; the visual one does.
    expect(
      keyboardInset({
        layoutHeight: 844,
        viewportHeight: 508,
        viewportOffsetTop: 0,
        typing: true,
      }),
    ).toBe(336);
  });

  it("counts a panned viewport as covered too", () => {
    // iOS pans to keep the caret in sight, which moves the covered strip without resizing it.
    expect(
      keyboardInset({
        layoutHeight: 844,
        viewportHeight: 508,
        viewportOffsetTop: 40,
        typing: true,
      }),
    ).toBe(296);
  });

  it("ignores a shrunken viewport with nothing typing into it", () => {
    // A pinch-zoom looks identical and means the opposite: the reader panned away on purpose.
    expect(
      keyboardInset({
        layoutHeight: 844,
        viewportHeight: 508,
        viewportOffsetTop: 0,
        typing: false,
      }),
    ).toBe(0);
  });

  it("ignores a difference too small to be a keyboard", () => {
    expect(
      keyboardInset({
        layoutHeight: 844,
        viewportHeight: 820,
        viewportOffsetTop: 0,
        typing: true,
      }),
    ).toBe(0);
  });

  it("gives back the keyboard bar's row as well, while it stands on the keyboard", () => {
    expect(
      keyboardInset({ layoutHeight: 844, viewportHeight: 508, viewportOffsetTop: 0, typing: true, scale: 1, bar: 44 }),
    ).toBe(380);
  });

  it("moves nothing under a reader who has zoomed in", () => {
    // The page is theirs to pan; the bar keeps to the glass on its own.
    expect(
      keyboardInset({ layoutHeight: 844, viewportHeight: 300, viewportOffsetTop: 0, typing: true, scale: 2, bar: 44 }),
    ).toBe(0);
  });
});

describe("showsKeyboardBar", () => {
  const reading = { typing: true, drawsKeyboard: true, ownKeyRow: false, covered: 336, scale: 1 };

  it("stands on a phone's keyboard for a focused field", () => {
    expect(showsKeyboardBar(reading)).toBe(true);
  });

  it("waits for the keyboard to arrive, so the page moves once for both", () => {
    expect(showsKeyboardBar({ ...reading, covered: 0 })).toBe(false);
  });

  it("is up whenever a field is focused while zoomed in, where the keyboard cannot be measured", () => {
    expect(showsKeyboardBar({ ...reading, covered: 0, scale: 2 })).toBe(true);
  });

  it("stays away from a desktop keyboard, a field with its own key row, and nothing focused", () => {
    expect(showsKeyboardBar({ ...reading, drawsKeyboard: false })).toBe(false);
    expect(showsKeyboardBar({ ...reading, ownKeyRow: true })).toBe(false);
    expect(showsKeyboardBar({ ...reading, typing: false })).toBe(false);
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
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          resized = callback;
        }
        observe() {}
        disconnect() {
          resized = () => {};
        }
      },
    );
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

describe("installKeyboardInset", () => {
  /** A phone: a coarse pointer, and a visual viewport a keyboard can shrink. */
  function phone() {
    const viewport = Object.assign(new EventTarget(), {
      height: 844,
      width: 390,
      offsetTop: 0,
      offsetLeft: 0,
      scale: 1,
    });
    vi.stubGlobal("visualViewport", viewport);
    vi.stubGlobal("innerHeight", 844);
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("coarse") }));
    return {
      keyboard(height: number) {
        viewport.height = 844 - height;
        viewport.dispatchEvent(new Event("resize"));
      },
    };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  it("clears the keyboard and the bar on it, raises the bar for the field, and brings the field back into sight", async () => {
    const device = phone();
    const field = document.createElement("textarea");
    field.scrollIntoView = vi.fn();
    document.body.append(field);
    const installed = installKeyboardInset();
    field.focus();
    device.keyboard(336);
    const root = document.documentElement;
    expect(root.style.getPropertyValue("--agent-panel-keyboard-inset")).toBe("380px");
    expect(keyboardBarSnapshot()).toMatchObject({ field, host: document.body, viewport: { bottom: 508, width: 390 } });
    expect(field.scrollIntoView).toHaveBeenCalledWith({ block: "nearest", inline: "nearest" });

    // The field's offer reaches the bar while it stays focused.
    field.setAttribute("data-keyboard-suggestion", "run the tests");
    await Promise.resolve();
    expect(keyboardBarSnapshot().suggestion).toBe("run the tests");

    installed.remove();
    expect(keyboardBarSnapshot().field).toBeNull();
    expect(root.style.getPropertyValue("--agent-panel-keyboard-inset")).toBe("");
  });

  it("leaves a field with its own key row to it, clearing only the keyboard", () => {
    const device = phone();
    const pane = document.createElement("section");
    pane.setAttribute("data-keyboard-bar", "off");
    const field = document.createElement("textarea");
    field.scrollIntoView = vi.fn();
    pane.append(field);
    document.body.append(pane);
    const installed = installKeyboardInset();
    field.focus();
    device.keyboard(336);
    expect(document.documentElement.style.getPropertyValue("--agent-panel-keyboard-inset")).toBe("336px");
    expect(keyboardBarSnapshot().field).toBeNull();
    installed.remove();
  });

  it("raises the bar for a field that brings its own keys, and tells it so", () => {
    const device = phone();
    const field = document.createElement("textarea");
    field.setAttribute("data-keyboard-bar", "keys");
    field.scrollIntoView = vi.fn();
    document.body.append(field);
    const installed = installKeyboardInset();
    field.focus();
    device.keyboard(336);
    expect(document.documentElement.style.getPropertyValue("--agent-panel-keyboard-inset")).toBe("380px");
    expect(keyboardBarSnapshot()).toMatchObject({ field, ownKeys: true });
    installed.remove();
  });
});
