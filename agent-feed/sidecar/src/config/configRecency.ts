// How old a session's last event may be before its activity bin changes, and before a session
// nobody keeps on the canvas is closed.
//
// Split out of `config.ts` for the reason every sibling here exists: the
// thresholds plus the ordering guard are one idea, and it is the catalog's
// bins and the idle sweep that read it, not the config registry's other entries.

import { integerEnvironment } from "@/config/configEnvironment";

export const staleThresholdMs = integerEnvironment(
  "AGENT_FEED_STALE_THRESHOLD_MS",
  2 * 60 * 60 * 1000,
  60 * 1000,
  7 * 24 * 60 * 60 * 1000,
);

export const readyThresholdMs = integerEnvironment(
  "AGENT_FEED_READY_THRESHOLD_MS",
  5 * 60 * 1000,
  1000,
  60 * 60 * 1000,
);

if (readyThresholdMs >= staleThresholdMs) {
  throw new Error("AGENT_FEED_READY_THRESHOLD_MS must be less than AGENT_FEED_STALE_THRESHOLD_MS");
}

/**
 * How long a Claude session off the canvas may go without an event before its pane is closed
 * (`terminal/session-panes/idleSessionSweep.ts`). 0 turns the sweep off.
 */
export const idleCloseAfterMs = integerEnvironment(
  "AGENT_FEED_IDLE_CLOSE_AFTER_MS",
  2 * 60 * 60 * 1000,
  0,
  30 * 24 * 60 * 60 * 1000,
);

/** How often the idle sweep looks. Nothing announces that time has passed, so it is a timer. */
export const idleSweepEveryMs = integerEnvironment(
  "AGENT_FEED_IDLE_SWEEP_EVERY_MS",
  60 * 60 * 1000,
  60 * 1000,
  24 * 60 * 60 * 1000,
);
