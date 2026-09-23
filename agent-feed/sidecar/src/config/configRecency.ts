// How old a session's last event may be before its activity bin changes.
//
// Split out of `config.ts` for the reason every sibling here exists: the two
// thresholds plus the ordering guard are one idea, and it is the catalog's
// bins that read it, not the config registry's other entries.

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
