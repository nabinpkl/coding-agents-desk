// A beating stream after the page wakes: one whose connection died in its sleep is reopened as soon
// as the beat it slept through fails to arrive, rather than after three beats of silence, and one
// that delivers that beat is left alone.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SubscribeHandlers } from "@/features/activity-feed/transport/AgentHttpTransport";
import { subscribeWithHeartbeat } from "@/features/activity-feed/transport/heartbeatStream";
import { resetStreamReconnects } from "@/features/telemetry/streamReconnects";

const BEAT_MS = 15_000;
let visibility: DocumentVisibilityState = "visible";

function sleep(ms: number): void {
  visibility = "hidden";
  document.dispatchEvent(new Event("visibilitychange"));
  // Asleep: the clock moves and nothing runs, as on a phone that locked.
  vi.setSystemTime(Date.now() + ms);
  visibility = "visible";
  document.dispatchEvent(new Event("visibilitychange"));
}

/** A transport that records each opening, and lets the test speak on the newest one. */
function transport() {
  const opened: SubscribeHandlers[] = [];
  return {
    opened,
    newest: () => opened[opened.length - 1]!,
    subscribe: (_path: string, handlers: SubscribeHandlers) => {
      opened.push(handlers);
      return () => {};
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
});

afterEach(() => {
  Reflect.deleteProperty(document, "visibilityState");
  resetStreamReconnects();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("a beating stream after the page wakes", () => {
  it("reopens one that slept through a beat and hears nothing just after waking", () => {
    const stream = transport();
    const onError = vi.fn();
    const stop = subscribeWithHeartbeat(stream, "/api/timeline", BEAT_MS, { onMessage: () => {}, onError });

    sleep(30_000);
    vi.advanceTimersByTime(1_999);
    expect(stream.opened).toHaveLength(1);
    vi.advanceTimersByTime(1);

    expect(stream.opened).toHaveLength(2);
    expect(onError).toHaveBeenCalledWith("silent for 32s after the page woke");
    stop();
  });

  it("leaves alone one that delivers the beat it slept through", () => {
    const stream = transport();
    const onError = vi.fn();
    const stop = subscribeWithHeartbeat(stream, "/api/timeline", BEAT_MS, { onMessage: () => {}, onError });

    sleep(30_000);
    stream.opened[0]!.onMessage('{"type":"heartbeat"}');
    vi.advanceTimersByTime(10_000);

    expect(stream.opened).toHaveLength(1);
    expect(onError).not.toHaveBeenCalled();
    stop();
  });

  it("waits for the next beat when it woke before missing one", () => {
    const stream = transport();
    const stop = subscribeWithHeartbeat(stream, "/api/timeline", BEAT_MS, { onMessage: () => {}, onError: () => {} });

    sleep(5_000);
    vi.advanceTimersByTime(BEAT_MS - 5_000 + 1_999);
    expect(stream.opened).toHaveLength(1);
    vi.advanceTimersByTime(1);

    expect(stream.opened).toHaveLength(2);
    stop();
  });

  it("retries a failed one at once on waking instead of finishing its wait", () => {
    const stream = transport();
    const stop = subscribeWithHeartbeat(stream, "/api/timeline", BEAT_MS, { onMessage: () => {}, onError: () => {} });
    for (let failures = 0; failures < 4; failures += 1) {
      stream.newest().onError("stream failed");
      vi.advanceTimersByTime(2 ** failures * 1_000);
    }
    stream.newest().onError("stream failed");
    expect(stream.opened).toHaveLength(5);

    sleep(60_000);

    expect(stream.opened).toHaveLength(6);
    stop();
  });
});
