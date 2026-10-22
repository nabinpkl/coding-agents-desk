// What a memory reading says about the page: always how many elements it holds, and the JS heap
// only where the browser reports one.

import { afterEach, describe, expect, it, vi } from "vitest";

const spans: { name: string; op: string; attributes: Record<string, unknown> }[] = [];
vi.mock("@sentry/react", () => ({
  startNewTrace: (run: () => void) => run(),
  startInactiveSpan: (options: (typeof spans)[number]) => {
    spans.push(options);
    return { end: () => {} };
  },
}));

const { pageMemoryAttributes, startPageMemorySamples } = await import("@/features/telemetry/pageMemory");

afterEach(() => {
  Reflect.deleteProperty(performance, "memory");
  document.body.replaceChildren();
  spans.length = 0;
  vi.useRealTimers();
});

describe("page memory", () => {
  it("counts the document's elements, with no heap where the browser has none, as on an iPhone", () => {
    document.body.append(document.createElement("div"), document.createElement("span"));
    const attributes = pageMemoryAttributes();
    expect(attributes).toEqual({ "page.dom_elements": document.getElementsByTagName("*").length });
    expect(attributes["page.dom_elements"]).toBeGreaterThanOrEqual(5);
  });

  it("adds Chrome's heap figures where it reports them", () => {
    Object.defineProperty(performance, "memory", {
      configurable: true,
      value: { usedJSHeapSize: 40e6, totalJSHeapSize: 60e6, jsHeapSizeLimit: 4e9 },
    });
    expect(pageMemoryAttributes()).toMatchObject({
      "page.js_heap.used": 40e6,
      "page.js_heap.total": 60e6,
      "page.js_heap.limit": 4e9,
    });
  });

  it("records a reading of its own every twenty minutes", () => {
    vi.useFakeTimers();
    startPageMemorySamples();
    vi.advanceTimersByTime(19 * 60_000);
    expect(spans).toHaveLength(0);
    vi.advanceTimersByTime(60_000);
    expect(spans).toEqual([
      expect.objectContaining({
        name: "panel memory",
        op: "ui.memory",
        attributes: expect.objectContaining({ "page.visible": true }),
      }),
    ]);
  });
});
