"use client";

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import type {
  LimitsStreamMessage,
  QuotaReport,
  UsageQuota,
  UsageVendorId,
  VendorQuotas,
} from "@agentdesk/agent-feed-wire";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";

/** The one method this needs, so a test can stand in for a whole data source with an object. */
export type LimitsFeed = Pick<SidecarDataSource, "subscribeLimits">;

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
  listeners: Set<() => void>;
  /** How many mounted readouts are watching, which is what holds the subscription open. */
  live: number;
  unsubscribe: (() => void) | null;
}

const IDLE: Reading = { kind: "idle" };

/**
 * One subscription per SIDECAR, not per session or per card.
 *
 * The rate limits are an account-wide fact, and the panel draws them on every session card at
 * once: a canvas of eight cards on one machine is eight readouts of one number. Keyed on the data
 * source because that object is already one per machine -- `BrowserSurfaces.sourceFor` builds and
 * keeps one per machine-session, and `useBotMachines.contextFor` hands each card its machine's --
 * so sharing here costs no plumbing and turns eight streams into one. That matters more than it
 * would for a plain read: the relay admits a bounded number of concurrent subscriptions.
 *
 * Weak, so a machine that goes away takes its entry with it rather than pinning a dead data source
 * for the life of the page.
 */
const entries = new WeakMap<LimitsFeed, Entry>();

function entryFor(feed: LimitsFeed): Entry {
  const existing = entries.get(feed);
  if (existing) return existing;
  const made: Entry = { reading: IDLE, listeners: new Set(), live: 0, unsubscribe: null };
  entries.set(feed, made);
  return made;
}

function publish(entry: Entry, reading: Reading) {
  entry.reading = reading;
  for (const listener of entry.listeners) listener();
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

function receive(entry: Entry, message: LimitsStreamMessage) {
  if (message?.type === "error") {
    publish(entry, { kind: "error", message: message.error.message });
    return;
  }
  // Checked rather than trusted, because this is rendered on every open card at once: a body
  // without `vendors` would otherwise throw inside the render below and take the whole session
  // card down with it, not just the meter. Named, not swallowed.
  const vendors = normalize(message?.report as QuotaReport);
  publish(entry, vendors
    ? { kind: "ready", vendors }
    : { kind: "error", message: "limits response carried no vendors" });
}

/**
 * The rate-limit meters for one machine, pushed as they move.
 *
 * Followed rather than polled because the sidecar is already told. Anthropic publishes the
 * account's windows on every API response and the proxy observer hands those headers over as each
 * request comes back, so a timer here would be asking for something already known -- and would be
 * at its most stale in the seconds after a turn is sent, which is when a reader actually looks.
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
    entry.live += 1;
    // Opened by the first card and closed by the last. The reading itself outlives the
    // subscription, so a card reopening shows the last known meters at once and then corrects.
    if (entry.live === 1 && !entry.unsubscribe) {
      if (entry.reading.kind === "idle") publish(entry, { kind: "loading" });
      entry.unsubscribe = feed.subscribeLimits({
        onMessage: (message) => receive(entry, message),
        onError: (reason) => publish(entry, { kind: "error", message: reason }),
      });
    }
    return () => {
      entry.live -= 1;
      if (entry.live > 0) return;
      entry.unsubscribe?.();
      entry.unsubscribe = null;
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
