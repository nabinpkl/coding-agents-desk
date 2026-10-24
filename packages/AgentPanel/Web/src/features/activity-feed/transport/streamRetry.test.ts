// When a dropped stream is tried again: a second after it drops, doubling to fifteen, and at once
// when the page wakes with the wait back at a second.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { streamRetry } from "@/features/activity-feed/transport/streamRetry";
import { resetStreamReconnects } from "@/features/telemetry/streamReconnects";

let visibility: DocumentVisibilityState = "visible";

function show(state: DocumentVisibilityState): void {
  visibility = state;
  document.dispatchEvent(new Event("visibilitychange"));
}

/** Fails the stream each time it is tried, and returns the waits between the tries. */
function waitsBetweenFailures(
  retry: ReturnType<typeof streamRetry>,
  tries: { times: number[] },
  count: number,
): number[] {
  retry.failed();
  const start = Date.now();
  for (let index = 0; index < count; index += 1) {
    const before = tries.times.length;
    while (tries.times.length === before) vi.advanceTimersByTime(250);
    retry.failed();
  }
  return tries.times.map((at, index) => at - (index === 0 ? start : tries.times[index - 1]!));
}

beforeEach(() => {
  vi.useFakeTimers();
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
});

afterEach(() => {
  Reflect.deleteProperty(document, "visibilityState");
  resetStreamReconnects();
  vi.useRealTimers();
});

describe("stream retry", () => {
  it("waits a second after a failure, doubling to fifteen, and a second again once it is back", () => {
    const tries = { times: [] as number[] };
    const retry = streamRetry("/api/test", () => tries.times.push(Date.now()));

    expect(waitsBetweenFailures(retry, tries, 6)).toEqual([1_000, 2_000, 4_000, 8_000, 15_000, 15_000]);

    retry.succeeded();
    tries.times.length = 0;
    expect(waitsBetweenFailures(retry, tries, 1)).toEqual([1_000]);
    retry.stop();
  });

  it("tries at once when the page wakes, and waits a second after the next failure", () => {
    const tries = { times: [] as number[] };
    const retry = streamRetry("/api/test", () => tries.times.push(Date.now()));
    waitsBetweenFailures(retry, tries, 4);
    const wokeAt = Date.now() + 3_000;

    show("hidden");
    vi.setSystemTime(wokeAt);
    show("visible");

    expect(tries.times[tries.times.length - 1]).toBe(wokeAt);
    retry.failed();
    vi.advanceTimersByTime(999);
    expect(tries.times).toHaveLength(5);
    vi.advanceTimersByTime(1);
    expect(tries.times).toHaveLength(6);
    retry.stop();
  });

  it("hands a wake with no try waiting to the stream, and runs nothing once stopped", () => {
    const tried = vi.fn();
    const onWake = vi.fn();
    const retry = streamRetry("/api/test", tried, { onWake });

    show("hidden");
    show("visible");
    expect(onWake).toHaveBeenCalledOnce();

    retry.failed();
    retry.stop();
    vi.advanceTimersByTime(60_000);
    show("hidden");
    show("visible");
    expect(tried).not.toHaveBeenCalled();
    expect(onWake).toHaveBeenCalledOnce();
  });
});
