// Following a stream whose sender beats, so that one which stops delivering is reopened.
//
// A connection that stops delivering without closing raises nothing: `EventSource` reconnects only
// on an error or an end, and a stalled proxy or a path that changed under a sleeping laptop
// produces neither. Whatever the stream last said then stays on screen looking live until a
// reload: a thread sat still while its agent kept working, and a composer kept offering to queue
// behind a turn that had finished. A sender that beats makes silence the stall itself, and
// reopening is the repair, because each of these streams opens with what is true now.

import type { AgentHttpTransport, SubscribeHandlers } from "@/features/activity-feed/transport/AgentHttpTransport";

/** Three missed beats: one late beat is jitter, three is a connection that stopped. */
const MISSED_BEATS = 3;

/**
 * Follows `path`, whose sender writes a message every `beatMs`, reopening it once it has been
 * silent for three beats, and soon after a failure. `handlers.onError` hears both, so a reader can
 * say it is not live; every message, beats included, goes to `onMessage`.
 */
export function subscribeWithHeartbeat(
  transport: Pick<AgentHttpTransport, "subscribe">,
  path: string,
  beatMs: number,
  handlers: SubscribeHandlers,
): () => void {
  let heardAt = Date.now();
  // A failed stream is reopened on a short backoff rather than left to the watchdog below.
  // `EventSource` retries a dropped connection by itself, but never one the server answered with
  // an error status, and a sidecar that has just restarted answers 503 until its catalog has been
  // read: a thread that reconnected inside that second sat dead for the watchdog's 45 seconds.
  // Cleared by an opening stream, so a reconnect the browser managed on its own is left alone.
  let retry: ReturnType<typeof setTimeout> | null = null;
  let failures = 0;
  const reopen = (): void => {
    close();
    heardAt = Date.now();
    close = open();
  };
  const reopenSoon = (): void => {
    if (retry !== null) return;
    const delay = Math.min(1_000 * 2 ** failures, beatMs);
    failures += 1;
    retry = setTimeout(() => {
      retry = null;
      reopen();
    }, delay);
  };
  const open = (): (() => void) =>
    transport.subscribe(path, {
      onOpen: (status) => {
        heardAt = Date.now();
        failures = 0;
        if (retry !== null) {
          clearTimeout(retry);
          retry = null;
        }
        handlers.onOpen?.(status);
      },
      onMessage: (payload) => {
        heardAt = Date.now();
        handlers.onMessage(payload);
      },
      onError: (reason) => {
        handlers.onError(reason);
        reopenSoon();
      },
    });
  let close = open();
  // Checked on the beat rather than armed per message, so a busy stream costs a timestamp write
  // and nothing else. A throttled background tab checks late, which only delays the repair.
  const watchdog = setInterval(() => {
    const silentFor = Date.now() - heardAt;
    if (silentFor < beatMs * MISSED_BEATS) return;
    const seconds = Math.round(silentFor / 1000);
    console.warn(`[stream] ${path} silent for ${seconds}s, reopening`);
    handlers.onError(`silent for ${seconds}s`);
    reopen();
  }, beatMs);
  return () => {
    clearInterval(watchdog);
    if (retry !== null) clearTimeout(retry);
    close();
  };
}
