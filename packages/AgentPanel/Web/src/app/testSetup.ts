import "@testing-library/jest-dom";
import { afterEach } from "vitest";
import { notifyManager } from "@tanstack/react-query";
import { panelQueryClient } from "@/query/panelQuery";

// TanStack Query tells components about an answer on a timer by default, which puts every answer
// a task behind the promise that produced it. A suite flushes promises, not timers, so the answer
// is delivered on a microtask instead: the same order, without the timer.
notifyManager.setScheduler(queueMicrotask);

// The page's one query cache outlives a test the way it outlives a component. Most suites build a
// fresh fake data source, whose key no other test can share, but one that reuses a module-level
// fake would otherwise read the previous test's answer instead of asking.
afterEach(() => {
  panelQueryClient.clear();
});

// Node's experimental Web Storage global shadows jsdom under Bun-spawned Vitest unless Node was
// given a persistence file. Replace it without reading the warning-producing getter, keeping the
// browser contract deterministic with the same in-memory semantics jsdom normally supplies.
const values = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => [...values.keys()][index] ?? null,
    removeItem: (key: string) => { values.delete(key); },
    setItem: (key: string, value: string) => { values.set(key, String(value)); },
  } satisfies Storage,
});

// jsdom has no ResizeObserver, and components that measure their own layout construct one on
// mount. An inert default keeps every suite from throwing on a browser API it does not exercise;
// a test that needs to drive a measurement stubs its own recording version over this.
Object.defineProperty(globalThis, "ResizeObserver", {
  configurable: true,
  value: class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
});

// jsdom has no matchMedia either, and Vitest 4 refuses to spy on a property that is not a function,
// so the suites that pose as a touch device need one to wrap. Matching nothing is what every guarded
// caller already read from its absence; a suite that wants a query to match spies on this.
if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent: () => false,
    }) as MediaQueryList,
  });
}

// Everything below patches the browser a suite is running IN, and a few suites deliberately run
// under `node` instead: the dev-server modules never touch a DOM, and one of them loads esbuild,
// which refuses to start under jsdom's `TextEncoder`. Without this guard those suites fail while
// collecting, on a line about `scrollIntoView`, which says nothing about the real mismatch.
if (typeof Element !== "undefined") {
  // jsdom implements no scrolling at all, so `scrollIntoView` is simply absent and a component that
  // brings its own element into view throws rather than doing nothing. A no-op keeps that call
  // harmless everywhere; a test that cares which element was scrolled spies on this.
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    writable: true,
    value: function scrollIntoView() {},
  });

  // `scrollTo` is absent for the same reason, and unlike `scrollIntoView` its absence is not
  // harmless: the virtualiser reaches its scroller through it, so `scrollToIndex` silently does
  // nothing and a component that scrolls itself looks broken only in the browser. jsdom does keep an
  // assigned `scrollTop`, so writing the offset through is the behaviour a browser has, minus the
  // scroll event a real one dispatches -- a test that needs the listeners to hear it still fires
  // that itself.
  Object.defineProperty(Element.prototype, "scrollTo", {
    configurable: true,
    writable: true,
    value: function scrollTo(this: Element, options?: number | ScrollToOptions, y?: number) {
      if (typeof options === "number") {
        this.scrollLeft = options;
        if (typeof y === "number") this.scrollTop = y;
        return;
      }
      if (typeof options?.left === "number") this.scrollLeft = options.left;
      if (typeof options?.top === "number") this.scrollTop = options.top;
    },
  });

  // jsdom implements no PointerEvent, and Testing Library's fallback drops the coordinates with it,
  // so a pointer-driven component reads `clientX` as undefined and every drag assertion passes or
  // fails for the wrong reason. MouseEvent already carries the coordinate contract these components
  // use; this adds only the pointer identity on top.
  if (typeof (globalThis as { PointerEvent?: unknown }).PointerEvent === "undefined") {
    class JsdomPointerEvent extends MouseEvent {
      readonly pointerId: number;
      readonly pointerType: string;
      readonly isPrimary: boolean;

      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 0;
        this.pointerType = init.pointerType ?? "mouse";
        this.isPrimary = init.isPrimary ?? true;
      }
    }
    Object.defineProperty(globalThis, "PointerEvent", {
      configurable: true,
      value: JsdomPointerEvent,
    });
  }

  // jsdom implements no object URLs, so a component that previews a file the user just handed it
  // throws on `URL.createObjectURL` rather than showing nothing. A counter keeps each one distinct,
  // which is what a test asserting "this preview is not that preview" needs.
  if (typeof URL.createObjectURL !== "function") {
    let issued = 0;
    URL.createObjectURL = () => `blob:agent-panel/${(issued += 1)}`;
    URL.revokeObjectURL = () => {};
  }
}
