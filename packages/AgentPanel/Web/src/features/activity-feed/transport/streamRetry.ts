// When to try a dropped stream again, for every stream the panel reopens itself: a session's
// transcript and composer state (`heartbeatStream.ts`), each machine's Bots and its Sessions list.
//
// A second after it drops, then 2, 4 and 8, then every 15. Doubling because the two outages worth
// surviving have different shapes: a sidecar restart is over within seconds, and a machine that is
// off for an hour should not be asked several times a second by every stream the page holds.
//
// And at once when the page wakes (`pageWake.ts`), with the wait back at a second. The doubling
// otherwise outlives the outage that caused it: a phone that locks while its streams are failing
// can come back with the wait already at fifteen seconds, and the first tries after a wake fail
// anyway while its connection comes back (on 2026-10-19 the iPhone's requests in its first second
// awake all failed), so each try after them waited the full fifteen.
//
// Each drop, try and return is reported to `streamReconnects.ts`, which times the reconnect.

import { onPageWake, type PageWake } from "@/features/activity-feed/transport/pageWake";
import { trackReconnects } from "@/features/telemetry/streamReconnects";

/** The longest wait between tries. */
const RETRY_MAX_MS = 15_000;

export interface StreamRetry {
  /** It failed: try again after the wait, unless a try is already waiting. */
  failed(): void;
  /** It went quiet without failing: try again now. */
  stalled(): void;
  /** It is back: the next failure waits a second again. */
  succeeded(): void;
  /** Its reader is done with it: nothing runs after this. */
  stop(): void;
}

/**
 * Calls `retry` to reopen `stream` (a path, or a name for a stream per machine) after each failure.
 *
 * `onWake` hears a wake that found no try waiting, for a stream that can tell a dead connection
 * from a quiet one.
 */
export function streamRetry(
  stream: string,
  retry: () => void,
  options: { onWake?: (wake: PageWake) => void } = {},
): StreamRetry {
  const reconnects = trackReconnects(stream);
  let failures = 0;
  let waiting: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const cancel = (): void => {
    if (waiting !== null) clearTimeout(waiting);
    waiting = null;
  };
  const run = (): void => {
    waiting = null;
    reconnects.tried();
    retry();
  };
  const stopWake = onPageWake((wake) => {
    failures = 0;
    if (waiting === null) {
      options.onWake?.(wake);
      return;
    }
    cancel();
    run();
  });
  return {
    failed() {
      if (stopped) return;
      reconnects.dropped("error");
      if (waiting !== null) return;
      const delay = Math.min(1_000 * 2 ** failures, RETRY_MAX_MS);
      failures += 1;
      waiting = setTimeout(run, delay);
    },
    stalled() {
      if (stopped) return;
      reconnects.dropped("silent");
      cancel();
      run();
    },
    succeeded() {
      failures = 0;
      cancel();
      reconnects.back();
    },
    stop() {
      stopped = true;
      cancel();
      stopWake();
      reconnects.closed();
    },
  };
}
