import "@testing-library/jest-dom";

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

// jsdom implements no scrolling at all, so `scrollIntoView` is simply absent and a component that
// brings its own element into view throws rather than doing nothing. A no-op keeps that call
// harmless everywhere; a test that cares which element was scrolled spies on this.
Object.defineProperty(Element.prototype, "scrollIntoView", {
  configurable: true,
  writable: true,
  value: function scrollIntoView() {},
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
