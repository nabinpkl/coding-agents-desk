// Following a stream whose sender beats, so that one which stops delivering is reopened.
//
// A connection that stops delivering without closing raises nothing: `EventSource` reconnects only
// on an error or an end, and a stalled proxy or a path that changed under a sleeping laptop
// produces neither. Whatever the stream last said then stays on screen looking live until a
// reload: a thread sat still while its agent kept working, and a composer kept offering to queue
// behind a turn that had finished. A sender that beats makes silence the stall itself, and
// reopening is the repair, because each of these streams opens with what is true now.
//
// A page that wakes is checked sooner than three beats. On 2026-10-19 the iPhone came back after
// 90 seconds and again after 404, and its session streams had heard nothing the whole time without
// a single error; the three-beat check is all that caught them. A stream that slept through a beat
// has that beat waiting for it if its connection is alive, so after a wake it must hear something
// within a beat of the last thing it heard, or be reopened.

import type { AgentHttpTransport, SubscribeHandlers } from "@/features/activity-feed/transport/AgentHttpTransport";
import { streamRetry } from "@/features/activity-feed/transport/streamRetry";

/** Three missed beats: one late beat is jitter, three is a connection that stopped. */
const MISSED_BEATS = 3;

/** How late a beat may be after a wake: the time to deliver what waited, and the trip itself. */
const WAKE_GRACE_MS = 2_000;

/**
 * Follows `path`, whose sender writes a message every `beatMs`, reopening it once it has been
 * silent for three beats, soon after a failure (`streamRetry.ts`), and when a page that woke hears
 * nothing on it in time. `handlers.onError` hears all three, so a reader can say it is not live;
 * every message, beats included, goes to `onMessage`.
 */
export function subscribeWithHeartbeat(
  transport: Pick<AgentHttpTransport, "subscribe">,
  path: string,
  beatMs: number,
  handlers: SubscribeHandlers,
): () => void {
  let heardAt = Date.now();
  let wakeCheck: ReturnType<typeof setTimeout> | null = null;
  const open = (): (() => void) =>
    transport.subscribe(path, {
      onOpen: (status) => {
        heardAt = Date.now();
        // A reconnect the browser managed on its own leaves nothing to retry.
        retry.succeeded();
        handlers.onOpen?.(status);
      },
      onMessage: (payload) => {
        heardAt = Date.now();
        handlers.onMessage(payload);
      },
      // `EventSource` retries a dropped connection by itself, but never one the server answered
      // with an error status, and a sidecar that has just restarted answers 503 until its catalog
      // has been read: a thread that reconnected inside that second sat dead for the watchdog's 45
      // seconds before this retried it.
      onError: (reason) => {
        handlers.onError(reason);
        retry.failed();
      },
    });
  let close = (): void => {};
  const reopen = (): void => {
    close();
    heardAt = Date.now();
    close = open();
  };
  const stall = (silentFor: number, why: string): void => {
    const said = `silent for ${Math.round(silentFor / 1000)}s${why}`;
    console.warn(`[stream] ${path} ${said}, reopening`);
    handlers.onError(said);
    retry.stalled();
  };
  const checkAfterWake = (): void => {
    const wokeAt = Date.now();
    if (wakeCheck !== null) clearTimeout(wakeCheck);
    wakeCheck = setTimeout(
      () => {
        wakeCheck = null;
        if (heardAt < wokeAt) stall(Date.now() - heardAt, " after the page woke");
      },
      Math.max(heardAt + beatMs, wokeAt) + WAKE_GRACE_MS - wokeAt,
    );
  };
  const retry = streamRetry(path.split("?")[0]!, reopen, { onWake: checkAfterWake });
  close = open();
  // Checked on the beat rather than armed per message, so a busy stream costs a timestamp write
  // and nothing else. A throttled background tab checks late, which only delays the repair.
  const watchdog = setInterval(() => {
    const silentFor = Date.now() - heardAt;
    if (silentFor >= beatMs * MISSED_BEATS) stall(silentFor, "");
  }, beatMs);
  return () => {
    clearInterval(watchdog);
    if (wakeCheck !== null) clearTimeout(wakeCheck);
    retry.stop();
    close();
  };
}
