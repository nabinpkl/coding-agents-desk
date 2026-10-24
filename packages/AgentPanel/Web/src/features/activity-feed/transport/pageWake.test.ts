// What counts as the page coming back: shown after it was hidden, with how long it was hidden, or
// the network returning. Showing a page that was never hidden is not a return.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  lastPageWake,
  onPageWake,
  pageAsleep,
  resetPageWake,
  type PageWake,
} from "@/features/activity-feed/transport/pageWake";

let visibility: DocumentVisibilityState = "visible";

function show(state: DocumentVisibilityState): void {
  visibility = state;
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  vi.useFakeTimers();
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
});

afterEach(() => {
  Reflect.deleteProperty(document, "visibilityState");
  resetPageWake();
  vi.useRealTimers();
});

describe("page wake", () => {
  it("says how long the page was hidden when it shows again", () => {
    const wakes: PageWake[] = [];
    const stop = onPageWake((wake) => wakes.push(wake));

    show("hidden");
    expect(pageAsleep()).toBe(true);
    vi.advanceTimersByTime(90_000);
    show("visible");

    expect(wakes).toEqual([{ cause: "visible", at: Date.now(), hiddenMs: 90_000 }]);
    expect(lastPageWake()).toEqual(wakes[0]);
    expect(pageAsleep()).toBe(false);
    stop();
  });

  it("counts the network coming back, and not a page that was never hidden", () => {
    const wakes: PageWake[] = [];
    const stop = onPageWake((wake) => wakes.push(wake));

    show("visible");
    window.dispatchEvent(new Event("online"));

    expect(wakes).toEqual([{ cause: "online", at: Date.now(), hiddenMs: 0 }]);
    stop();
  });

  it("stops listening once the last listener has stopped", () => {
    const heard = vi.fn();
    onPageWake(heard)();

    show("hidden");
    show("visible");

    expect(heard).not.toHaveBeenCalled();
  });
});
