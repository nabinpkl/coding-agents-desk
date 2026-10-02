// Stopping the sidecar, which has to work on a sidecar that cannot hear the request.
//
// SIGTERM is the polite ask: the sidecar's handler drains its streams, closes its listener and lets
// go of the port, about half a second end to end. But a handler is JavaScript, and a sidecar whose
// main thread is wedged never runs it. Measured 2026-10-02: Bun's main thread and its File Watcher
// thread both parked on one `os_unfair_lock` (the same deadlock as 2026-09-09), the host's health
// check stopped the supervisor, the supervisor sent SIGTERM and left two seconds later, and the
// sidecar outlived it -- reparented to launchd, still LISTENing on 7682 and accepting nothing. Every
// supervisor the host started after that ran a sidecar that could not have the port, so the machine
// sat in a respawn loop with no feed until somebody killed the orphan by hand.
//
// So a stop that is not answered in time becomes SIGKILL, which needs nothing from the process.

/**
 * How long a sidecar gets to stop itself before it is killed.
 *
 * Bounded from above by the host: it gives the supervisor two seconds after SIGTERM before killing
 * it (`terminateCurrentProcess` in `AgentFeedSidecarProcess.swift`), and a supervisor killed first
 * cannot escalate, which is the orphan this file exists to prevent. Bounded from below by a healthy
 * sidecar's own shutdown, measured at about 520ms from SIGTERM to the next one starting.
 */
export const STOP_GRACE_MS = 1_500;

/** The part of a `Bun.spawn` subprocess this needs, so a test can hand it any child. */
export type StoppableChild = {
  readonly pid: number;
  readonly exited: Promise<unknown>;
  kill(signal?: number | NodeJS.Signals): void;
};

/** Ask the child to stop, and make it stop if it has not within `graceMs`. */
export function stopChild(
  child: StoppableChild,
  log: (message: string) => void,
  graceMs: number = STOP_GRACE_MS,
): void {
  child.kill("SIGTERM");
  const escalate = setTimeout(() => {
    log(`sidecar ${child.pid} did not stop within ${graceMs}ms of SIGTERM; sending SIGKILL`);
    child.kill("SIGKILL");
  }, graceMs);
  void child.exited.finally(() => clearTimeout(escalate));
}
