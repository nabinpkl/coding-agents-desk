"use client";

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import type { QuotaReport, UsageQuota, UsageVendorId, VendorQuotas } from "@agentdesk/agent-feed-wire";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";

/**
 * How long a reading is reused, and how often a live readout re-reads it.
 *
 * The meters move only when one of this machine's agents gets an API response back, so this is not
 * about precision. It bounds how stale the composer's chip can be, and it is what stops a reader
 * opening and closing the popover from asking the sidecar again for a number they are watching.
 */
const REUSE_MS = 30_000;

/** The one method this needs, so a test can stand in for a whole data source with an object. */
export type LimitsFeed = Pick<SidecarDataSource, "fetchLimits">;

export type LimitsState =
  | { kind: "idle" }
  | { kind: "loading" }
  /** Every window every vendor publishes, already ordered by the sidecar. Empty is a real answer. */
  | { kind: "ready"; quotas: UsageQuota[] }
  | { kind: "error"; message: string };

/** The store's own state, which keeps the vendors apart so each reader can pick its own. */
type Reading =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; vendors: VendorQuotas[] }
  | { kind: "error"; message: string };

interface Entry {
  reading: Reading;
  readAt: number;
  inFlight: boolean;
  listeners: Set<() => void>;
  /** How many mounted readouts are displaying this continuously, which is what earns the timer. */
  live: number;
  timer: ReturnType<typeof setInterval> | null;
}

const IDLE: Reading = { kind: "idle" };

/**
 * One reading per SIDECAR, not per session or per card.
 *
 * The rate limits are an account-wide fact, and the panel draws them on every session card at
 * once: a canvas of eight cards on one machine is eight readouts of one number. Keyed on the data
 * source because that object is already one per machine -- `BrowserSurfaces.sourceFor` builds and
 * keeps one per machine-session, and `useBotMachines.contextFor` hands each card its machine's --
 * so sharing here costs no plumbing and turns eight reads at mount into one.
 *
 * Weak, so a machine that goes away takes its entry with it rather than pinning a dead data source
 * for the life of the page.
 */
const entries = new WeakMap<LimitsFeed, Entry>();

function entryFor(feed: LimitsFeed): Entry {
  const existing = entries.get(feed);
  if (existing) return existing;
  const made: Entry = {
    reading: IDLE,
    readAt: 0,
    inFlight: false,
    listeners: new Set(),
    live: 0,
    timer: null,
  };
  entries.set(feed, made);
  return made;
}

function publish(entry: Entry, reading: Reading) {
  entry.reading = reading;
  for (const listener of entry.listeners) listener();
}

function refresh(feed: LimitsFeed, entry: Entry) {
  if (entry.inFlight) return;
  const now = Date.now();
  if (now - entry.readAt < REUSE_MS) return;
  entry.inFlight = true;
  // A reading already on screen stays while the next one is fetched: it was true when it arrived,
  // and replacing it with a spinner would blank the only numbers the readout is for.
  if (entry.reading.kind !== "ready") publish(entry, { kind: "loading" });
  void feed.fetchLimits().then(
    (report: QuotaReport) => {
      entry.inFlight = false;
      entry.readAt = Date.now();
      // Checked rather than trusted, because this is the one call whose answer is rendered on
      // every open card at once: a body without `vendors` -- a sidecar too old for the route, a
      // proxy answering with something else -- would otherwise throw inside the render below and
      // take the whole session card down with it, not just the meter. Named, not swallowed.
      const vendors = normalize(report);
      if (!vendors) {
        publish(entry, { kind: "error", message: "limits response carried no vendors" });
        return;
      }
      publish(entry, { kind: "ready", vendors });
    },
    (error: unknown) => {
      entry.inFlight = false;
      // Stamped like a success, so a failure backs off instead of being retried immediately.
      // Measured on a Canvas card against a sidecar that did not have the route yet: without this
      // an open readout asked again on every render and the page took dozens of 404s in seconds.
      entry.readAt = Date.now();
      publish(entry, {
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    },
  );
}

/**
 * The report's vendors, or null where the body was not one.
 *
 * A vendor missing its `quotas` gets an empty list rather than being dropped: it published no
 * meter, which is a real answer and the same one the sidecar gives for a vendor it cannot read.
 */
function normalize(report: QuotaReport): VendorQuotas[] | null {
  if (!Array.isArray(report?.vendors)) return null;
  return report.vendors.map((vendor) => ({
    ...vendor,
    quotas: Array.isArray(vendor?.quotas) ? vendor.quotas : [],
  }));
}

/**
 * The rate-limit meters for one machine, shared by every readout pointed at it.
 *
 * Read continuously rather than on demand, because the composer's chip shows them the whole time a
 * card is open. The sharing above is what makes that affordable: one timer per machine, however
 * many cards are watching it.
 */
export function useLimits(
  feed: LimitsFeed | null,
  /** Show only this vendor's windows, or every vendor's where a surface wants them all. */
  vendor: UsageVendorId | null = null,
): LimitsState {
  const entry = feed ? entryFor(feed) : null;

  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!entry) return () => {};
      entry.listeners.add(onChange);
      return () => {
        entry.listeners.delete(onChange);
      };
    },
    [entry],
  );
  // The store's own object, unchanged between reads, because `useSyncExternalStore` compares
  // snapshots by identity and a fresh one per render is an infinite loop rather than a re-render.
  const reading = useSyncExternalStore(
    subscribe,
    () => entry?.reading ?? IDLE,
    () => IDLE,
  );

  useEffect(() => {
    // No sidecar to ask. The surface that has one always passes it; this keeps a readout rendered
    // without one from throwing rather than from quietly inventing a meter.
    if (!feed || !entry) return;
    refresh(feed, entry);
    entry.live += 1;
    // One timer per machine however many cards are watching, started by the first and stopped by
    // the last. Without the count, eight cards would each poll and the sharing above would buy
    // nothing.
    if (entry.live === 1 && entry.timer === null) {
      entry.timer = setInterval(() => refresh(feed, entry), REUSE_MS);
    }
    return () => {
      entry.live -= 1;
      if (entry.live > 0 || entry.timer === null) return;
      clearInterval(entry.timer);
      entry.timer = null;
    };
  }, [entry, feed]);

  return useMemo<LimitsState>(() => {
    if (reading.kind !== "ready") return reading;
    // One vendor's windows, where the caller names one. Both vendors meter five hours, so a Claude
    // card showing Codex's 5h beside its own would be two chips reading the same name at different
    // numbers -- a surface that looks broken and is worse than that, because either could be read
    // as the one about to stop you.
    const vendors = vendor ? reading.vendors.filter((each) => each.vendor === vendor) : reading.vendors;
    return { kind: "ready", quotas: vendors.flatMap((each) => each.quotas) };
  }, [reading, vendor]);
}
