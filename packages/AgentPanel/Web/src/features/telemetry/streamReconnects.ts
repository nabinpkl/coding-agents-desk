// How long the streams behind a "Reconnecting" chip take to come back, recorded once per reconnect:
// a span from the first stream dropping to the last one back, holding a child span per stream with
// how many tries it took and whether it came back at all.
//
// One record for the whole reconnect rather than one per stream: a phone that wakes reopens every
// stream it holds at once (14 to 36 on the iPhone's page loads, 2026-10-24), and a request per
// stream would compete with the streams for its link just as they come back.
//
// The clock restarts when the page wakes (`pageWake.ts`): time the page spent hidden is time nobody
// waited, so it goes beside the reconnect (`page.hidden_ms`) rather than inside it. A reconnect not
// over two minutes after its clock started is recorded as it stands, its missing streams marked
// down, because a machine that stays off would otherwise hold every later reconnect open with it.
//
// Fed by `streamRetry.ts`, which every stream that retries goes through. Its own trace and a `ui.`
// op, like `pageMemory.ts`, because that is what `tracesSampler` in `panelTelemetry.ts` keeps.

import { startInactiveSpan, startNewTrace } from "@sentry/react";
import { lastPageWake, onPageWake, pageAsleep, type PageWake } from "@/features/activity-feed/transport/pageWake";

/** Eight of the longest retry waits (`streamRetry.ts`), so only a stream that stays off reaches it. */
const RECONNECT_LIMIT_MS = 2 * 60_000;

/** Why a stream counts as dropped: it failed, or it went quiet without failing. */
export type DropCause = "error" | "silent";

type Outcome = "back" | "closed" | "down";

interface Drop {
  readonly stream: string;
  readonly cause: DropCause;
  readonly at: number;
  tries: number;
  ended: { readonly at: number; readonly outcome: Outcome } | null;
}

interface Reconnect {
  readonly cause: DropCause;
  readonly drops: Drop[];
  clockAt: number;
  wake: PageWake | null;
  limit: ReturnType<typeof setTimeout>;
  stopWake: () => void;
}

let current: Reconnect | null = null;

/** What one stream reports about itself. */
export interface ReconnectTracker {
  /** It dropped. Again before it is back changes nothing. */
  dropped(cause: DropCause): void;
  /** One more try at reopening it. */
  tried(): void;
  /** It is back. */
  back(): void;
  /** Its reader closed it. */
  closed(): void;
}

/** `stream` names it in the record: a path for one session's stream, a name for one per machine. */
export function trackReconnects(stream: string): ReconnectTracker {
  // Stays set after a reconnect that was cut off recorded it as down, so the stream adds nothing
  // more until it is back or closed: a machine that is off keeps failing every fifteen seconds.
  let drop: Drop | null = null;
  const end = (outcome: Outcome): void => {
    const ended = drop;
    drop = null;
    if (ended === null || ended.ended !== null) return;
    ended.ended = { at: Date.now(), outcome };
    if (current !== null && current.drops.every((each) => each.ended !== null)) finish(current);
  };
  return {
    dropped(cause) {
      if (drop !== null) return;
      drop = { stream, cause, at: Date.now(), tries: 0, ended: null };
      current ??= begin(cause, drop.at);
      current.drops.push(drop);
    },
    tried() {
      if (drop !== null && drop.ended === null) drop.tries += 1;
    },
    back: () => end("back"),
    closed: () => end("closed"),
  };
}

function begin(cause: DropCause, at: number): Reconnect {
  const reconnect: Reconnect = {
    cause,
    drops: [],
    clockAt: at,
    wake: lastPageWake(),
    limit: setTimeout(() => cutOff(reconnect), RECONNECT_LIMIT_MS),
    stopWake: () => {},
  };
  reconnect.stopWake = onPageWake((wake) => {
    reconnect.clockAt = wake.at;
    reconnect.wake = wake;
    clearTimeout(reconnect.limit);
    reconnect.limit = setTimeout(() => cutOff(reconnect), RECONNECT_LIMIT_MS);
  });
  return reconnect;
}

function cutOff(reconnect: Reconnect): void {
  if (current !== reconnect) return;
  // A limit that fell due while the page slept waits for the wake, which restarts the clock.
  if (pageAsleep()) {
    reconnect.limit = setTimeout(() => cutOff(reconnect), RECONNECT_LIMIT_MS);
    return;
  }
  const at = Date.now();
  for (const drop of reconnect.drops) drop.ended ??= { at, outcome: "down" };
  finish(reconnect);
}

function finish(reconnect: Reconnect): void {
  current = null;
  clearTimeout(reconnect.limit);
  reconnect.stopWake();
  const ended = reconnect.drops.map((drop) => ({ drop, end: drop.ended! }));
  // Only closed, never back: streams that ended by design (one that delivers its answer and
  // finishes reads as a failure to `EventSource`), not a reconnect anyone waited on.
  if (ended.every(({ end }) => end.outcome === "closed")) return;
  const { clockAt, wake } = reconnect;
  const count = (outcome: Outcome) => ended.filter(({ end }) => end.outcome === outcome).length;
  startNewTrace(() => {
    const span = startInactiveSpan({
      name: "streams reconnecting",
      op: "ui.stream.reconnect",
      startTime: clockAt,
      attributes: {
        "reconnect.cause": reconnect.cause,
        "reconnect.streams": ended.length,
        "reconnect.tries": ended.reduce((sum, { drop }) => sum + drop.tries, 0),
        "reconnect.back": count("back"),
        "reconnect.down": count("down"),
        "reconnect.closed": count("closed"),
        "page.visible": document.visibilityState === "visible",
        ...(wake ? { "page.hidden_ms": wake.hiddenMs, "page.since_wake_ms": clockAt - wake.at } : {}),
      },
    });
    for (const { drop, end } of ended) {
      const startTime = Math.max(drop.at, clockAt);
      startInactiveSpan({
        name: drop.stream,
        op: "ui.stream.reconnect.stream",
        parentSpan: span,
        startTime,
        attributes: { "stream.cause": drop.cause, "stream.tries": drop.tries, "stream.outcome": end.outcome },
      }).end(Math.max(end.at, startTime));
    }
    span.end(Math.max(clockAt, ...ended.map(({ end }) => end.at)));
  });
}

/** For tests: drop a reconnect in progress without recording it. */
export function resetStreamReconnects(): void {
  if (current === null) return;
  clearTimeout(current.limit);
  current.stopWake();
  current = null;
}
