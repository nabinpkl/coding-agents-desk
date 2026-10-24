// A reconnect as the archive records it: one span from the first stream dropping to the last one
// back, a child per stream with its tries, the time the page slept kept beside it rather than in
// it, and a stream that stays off marked down instead of holding the record open.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface Recorded {
  name: string;
  op: string;
  startTime: number;
  attributes: Record<string, unknown>;
  parent: Recorded | undefined;
  endTime?: number;
}

const spans: Recorded[] = [];
vi.mock("@sentry/react", () => ({
  startNewTrace: (run: () => void) => run(),
  startInactiveSpan: (options: Omit<Recorded, "parent"> & { parentSpan?: Recorded }) => {
    const span: Recorded = { ...options, parent: options.parentSpan };
    spans.push(span);
    return Object.assign(span, { end: (at: number) => (span.endTime = at) });
  },
}));

const { trackReconnects, resetStreamReconnects } = await import("@/features/telemetry/streamReconnects");
const { resetPageWake } = await import("@/features/activity-feed/transport/pageWake");

let visibility: DocumentVisibilityState = "visible";

function show(state: DocumentVisibilityState): void {
  visibility = state;
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_800_000_000_000);
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
});

afterEach(() => {
  Reflect.deleteProperty(document, "visibilityState");
  resetStreamReconnects();
  resetPageWake();
  spans.length = 0;
  vi.useRealTimers();
});

describe("stream reconnects", () => {
  it("records the streams that dropped together as one reconnect, ending when the last is back", () => {
    const timeline = trackReconnects("/api/sessions/claude/a/timeline");
    const bots = trackReconnects("Bots on mac");
    const start = Date.now();

    timeline.dropped("error");
    vi.advanceTimersByTime(500);
    bots.dropped("error");
    timeline.tried();
    timeline.back();
    expect(spans).toHaveLength(0);
    vi.advanceTimersByTime(2_500);
    bots.tried();
    bots.tried();
    bots.back();

    const [root, ...streams] = spans;
    expect(root).toMatchObject({
      name: "streams reconnecting",
      op: "ui.stream.reconnect",
      startTime: start,
      endTime: start + 3_000,
      attributes: { "reconnect.cause": "error", "reconnect.streams": 2, "reconnect.tries": 3, "reconnect.back": 2 },
    });
    expect(
      streams.map(({ name, parent, startTime, endTime, attributes }) => [
        name,
        parent,
        startTime,
        endTime,
        attributes["stream.tries"],
      ]),
    ).toEqual([
      ["/api/sessions/claude/a/timeline", root, start, start + 500, 1],
      ["Bots on mac", root, start + 500, start + 3_000, 2],
    ]);
  });

  it("starts the clock again when the page wakes, and says how long it slept", () => {
    const timeline = trackReconnects("/api/timeline");
    show("hidden");
    timeline.dropped("error");
    vi.setSystemTime(Date.now() + 600_000);
    const wokeAt = Date.now();
    show("visible");
    vi.advanceTimersByTime(4_000);
    timeline.back();

    expect(spans[0]).toMatchObject({
      startTime: wokeAt,
      endTime: wokeAt + 4_000,
      attributes: { "page.hidden_ms": 600_000, "page.since_wake_ms": 0 },
    });
  });

  it("records a stream that stays off as down after two minutes, and nothing more while it keeps failing", () => {
    const peer = trackReconnects("Bots on peer");
    peer.dropped("error");
    vi.advanceTimersByTime(120_000);

    expect(
      spans.map(({ name, attributes }) => [name, attributes["reconnect.down"] ?? attributes["stream.outcome"]]),
    ).toEqual([
      ["streams reconnecting", 1],
      ["Bots on peer", "down"],
    ]);
    peer.dropped("error");
    vi.advanceTimersByTime(300_000);
    expect(spans).toHaveLength(2);
  });

  it("records nothing for streams that were only closed while down", () => {
    const summary = trackReconnects("/api/summary");
    summary.dropped("error");
    summary.closed();
    vi.advanceTimersByTime(300_000);

    expect(spans).toHaveLength(0);
  });
});
