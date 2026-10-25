// Knowing whether the keyboard is up, and how much of the screen it and its accessory
// are covering between them.

import { act, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  beforeInput,
  setup,
  stubAccessoryObserver,
} from "@/features/desktop-viewer/keyboard-input/useDesktopKeyboardHarness";

describe("useDesktopKeyboard", () => {
  const accessoryObservers = stubAccessoryObserver();

  it("does not mistake a resized WKWebView for a dismissed keyboard", () => {
    const previous = window.visualViewport;
    const originalHeight = window.innerHeight;
    const viewport = Object.assign(new EventTarget(), { height: originalHeight, offsetTop: 0 });
    Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
    try {
      const harness = setup();
      act(() => harness.controller.showManually());
      viewport.height = originalHeight - 300;
      act(() => viewport.dispatchEvent(new Event("resize")));
      Object.defineProperty(window, "innerHeight", { configurable: true, value: viewport.height });
      act(() => viewport.dispatchEvent(new Event("resize")));
      beforeInput(harness.controller, harness.capture as HTMLTextAreaElement, "deleteContentBackward", null);
      expect(harness.controller.presentation.presentation).toBe("shown");
      expect(harness.controller.softwareKeyboardVisible).toBe(true);
      expect(harness.controller.accessoryBottom).toBe(0);
      expect(document.activeElement).toBe(harness.capture);
    } finally {
      Object.defineProperty(window, "innerHeight", { configurable: true, value: originalHeight });
      Object.defineProperty(window, "visualViewport", { configurable: true, value: previous });
    }
  });

  it("dismisses from visualViewport events without polling", () => {
    const previous = window.visualViewport;
    const viewport = new EventTarget() as EventTarget & {
      height: number;
      offsetTop: number;
    };
    viewport.height = window.innerHeight;
    viewport.offsetTop = 0;
    Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
    try {
      const harness = setup();
      act(() => harness.controller.showManually());
      viewport.height = window.innerHeight - 200;
      act(() => viewport.dispatchEvent(new Event("resize")));
      viewport.height = window.innerHeight;
      act(() => viewport.dispatchEvent(new Event("resize")));
      expect(harness.controller.presentation.presentation).toBe("hidden");
      expect(harness.controller.softwareKeyboardVisible).toBe(false);
    } finally {
      Object.defineProperty(window, "visualViewport", { configurable: true, value: previous });
    }
  });

  it("stays up when the browser's keyboard leaves because the deck took over", () => {
    const media = vi.spyOn(window, "matchMedia").mockImplementation(
      (query: string) =>
        ({
          matches: query === "(hover: none) and (pointer: coarse)",
          media: query,
          onchange: null,
          addEventListener() {},
          removeEventListener() {},
          addListener() {},
          removeListener() {},
          dispatchEvent: () => false,
        }) as MediaQueryList,
    );
    const previous = window.visualViewport;
    const viewport = Object.assign(new EventTarget(), {
      height: window.innerHeight,
      offsetTop: 0,
    });
    Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
    try {
      const harness = setup();
      act(() => harness.controller.setKeyboardMode("native"));
      act(() => harness.controller.showManually());
      viewport.height = window.innerHeight - 200;
      act(() => viewport.dispatchEvent(new Event("resize")));
      expect(harness.controller.softwareKeyboardVisible).toBe(true);

      // Switching back dismisses the browser's keyboard, so the viewport comes back. That is the
      // deck arriving, not the keyboard being dismissed, and must not tear the strip down.
      act(() => harness.controller.setKeyboardMode("deck"));
      viewport.height = window.innerHeight;
      act(() => viewport.dispatchEvent(new Event("resize")));

      expect(harness.controller.presentation.presentation).toBe("shown");
      expect(harness.controller.showsDeck).toBe(true);
      expect(harness.controller.softwareKeyboardVisible).toBe(false);
    } finally {
      window.localStorage.removeItem("agentdesk.desktop-keyboard-mode.v1");
      Object.defineProperty(window, "visualViewport", { configurable: true, value: previous });
      media.mockRestore();
    }
  });

  it("reports the whole occluded band, keyboard and accessory together", () => {
    const previous = window.visualViewport;
    const originalHeight = window.innerHeight;
    const viewport = Object.assign(new EventTarget(), { height: originalHeight, offsetTop: 0 });
    Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
    // A page that keeps its full height under the keyboard, as the standalone viewer does.
    const page = vi
      .spyOn(document.documentElement, "getBoundingClientRect")
      .mockReturnValue({ bottom: originalHeight } as DOMRect);
    try {
      const harness = setup();
      expect(harness.controller.occludedBottom).toBe(0);
      act(() => harness.controller.showManually());

      // A layout viewport that has not caught up to the keyboard: the accessory floats 300px up.
      viewport.height = originalHeight - 300;
      act(() => viewport.dispatchEvent(new Event("resize")));
      expect(harness.controller.accessoryBottom).toBe(300);

      const accessory = screen.getByLabelText("accessory");
      vi.spyOn(accessory, "getBoundingClientRect").mockReturnValue({ top: originalHeight - 380 } as DOMRect);
      act(() => accessoryObservers.get(accessory)!());

      // The video's box ends at the accessory's top, which is both occluders in one number.
      expect(harness.controller.occludedBottom).toBe(380);

      act(() => harness.controller.hide());
      expect(harness.controller.occludedBottom).toBe(300);
    } finally {
      page.mockRestore();
      Object.defineProperty(window, "visualViewport", { configurable: true, value: previous });
    }
  });

  it("counts only what covers the page, once the page has given the keyboard back", () => {
    // Inside the panel the page ends at the keyboard's top already (`app/page/keyboardInset.ts`),
    // so adding the keyboard again would leave the video no height at all.
    const previous = window.visualViewport;
    const originalHeight = window.innerHeight;
    const viewport = Object.assign(new EventTarget(), { height: originalHeight, offsetTop: 0 });
    Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
    const page = vi
      .spyOn(document.documentElement, "getBoundingClientRect")
      .mockReturnValue({ bottom: originalHeight } as DOMRect);
    try {
      const harness = setup();
      act(() => harness.controller.showManually());
      viewport.height = originalHeight - 300;
      act(() => viewport.dispatchEvent(new Event("resize")));
      page.mockReturnValue({ bottom: originalHeight - 300 } as DOMRect);
      const accessory = screen.getByLabelText("accessory");
      vi.spyOn(accessory, "getBoundingClientRect").mockReturnValue({ top: originalHeight - 380 } as DOMRect);
      act(() => accessoryObservers.get(document.documentElement)!());
      expect(harness.controller.occludedBottom).toBe(80);
    } finally {
      page.mockRestore();
      Object.defineProperty(window, "visualViewport", { configurable: true, value: previous });
    }
  });
});
