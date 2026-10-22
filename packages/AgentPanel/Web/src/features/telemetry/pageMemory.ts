// How much this page holds: recorded on each page load as it ends, and every twenty minutes after
// as a span of its own, so a tab left open for a day shows whether it grew.
//
// Two readings. The JS heap is Chrome's non-standard `performance.memory`, which Safari and every
// iPhone browser (all WebKit) lack; Chrome without `--enable-precise-memory-info` also rounds it and
// refreshes it at most every twenty minutes (Blink's `MemoryInfo`), which is why sampling it more
// often would only repeat the last value. The count of elements in the document is exact
// everywhere, and is the only reading the phone gets: a card that never lets go of its rows shows
// there first.
//
// Its own trace and a `ui.` op, like `feedSnapBack.ts`, because that is what `tracesSampler` in
// `panelTelemetry.ts` keeps once the page load is over.

import { startInactiveSpan, startNewTrace } from "@sentry/react";

/** Chrome's `performance.memory`, in bytes. */
type ChromeHeap = { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number };

/**
 * A poll, because nothing announces that memory changed. Twenty minutes is the most often Chrome
 * refreshes the heap figures a page can read, and a leak worth finding shows over hours.
 */
const SAMPLE_INTERVAL_MS = 20 * 60_000;

export function pageMemoryAttributes(): Record<string, number> {
  const attributes: Record<string, number> = { "page.dom_elements": document.getElementsByTagName("*").length };
  const heap = (performance as Performance & { memory?: ChromeHeap }).memory;
  if (heap) {
    attributes["page.js_heap.used"] = heap.usedJSHeapSize;
    attributes["page.js_heap.total"] = heap.totalJSHeapSize;
    attributes["page.js_heap.limit"] = heap.jsHeapSizeLimit;
  }
  return attributes;
}

function recordPageMemory(): void {
  startNewTrace(() => {
    startInactiveSpan({
      name: "panel memory",
      op: "ui.memory",
      attributes: { ...pageMemoryAttributes(), "page.visible": document.visibilityState === "visible" },
    }).end();
  });
}

/** Once per page; the telemetry modules are never swapped in place, so nothing installs it twice. */
export function startPageMemorySamples(): void {
  setInterval(recordPageMemory, SAMPLE_INTERVAL_MS);
}
