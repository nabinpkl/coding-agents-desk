"use client";

import { useMemo } from "react";
import type {
  LimitsStreamMessage,
  QuotaReport,
  UsageQuota,
  QuotaVendorId,
  VendorQuotas,
} from "@agentdesk/agent-feed-wire";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import { createSourceStore, useSourceStore, type SourceStore } from "@/features/activity-feed/data-source/sourceStore";

/** The one method this needs, so a test can stand in for a whole data source with an object. */
export type LimitsFeed = Pick<SidecarDataSource, "subscribeLimits">;

export type LimitsState =
  | { kind: "idle" }
  | { kind: "loading" }
  /** Every window every vendor publishes, already ordered by the sidecar. Empty is a real answer. */
  | {
      kind: "ready";
      quotas: UsageQuota[];
      /**
       * Why a selected vendor's meter could not be read (OpenCode Go), or absent. Unreadable is not
       * 0%: surfaces say "unavailable" instead of drawing a bar.
       */
      unavailable?: string;
    }
  | { kind: "error"; message: string };

/** The store's own state, which keeps the vendors apart so each reader can pick its own. */
type Reading =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; vendors: VendorQuotas[] }
  | { kind: "error"; message: string };

const IDLE: Reading = { kind: "idle" };

/**
 * Stands in for "no sidecar to ask", so the hook below has one store and one source to read either
 * way. Never subscribed to: a readout rendered without a sidecar stays empty rather than inventing a
 * meter.
 */
const NO_FEED: LimitsFeed = { subscribeLimits: () => () => {} };

/** Each machine's open stream, so the last reader leaving can close it. */
const streams = new WeakMap<LimitsFeed, () => void>();
const goStreams = new WeakMap<LimitsFeed, () => void>();

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
 * The stream is opened by the first card and closed by the last; the reading itself outlives it, so
 * a card reopening shows the last known meters at once and then corrects.
 */
const limits = limitsStore(false);
/**
 * The OpenCode Go plan meter, one subscription per sidecar like the above but its own stream:
 * the sidecar polls opencode.ai for it, so it is opened by a mounted Go meter (an expanded
 * opencode session card on the Go plan) and by nothing else.
 */
const goLimits = limitsStore(true);

function limitsStore(go: boolean) {
  const open = go ? goStreams : streams;
  const store = createSourceStore<LimitsFeed, Reading>({
    initial: () => IDLE,
    opened: (feed) => {
      if (feed === NO_FEED) return;
      if (store.get(feed).kind === "idle") store.set(feed, () => ({ kind: "loading" }));
      open.set(
        feed,
        feed.subscribeLimits(
          {
            onMessage: (message) => receive(store, feed, message),
            onError: (reason) => store.set(feed, () => ({ kind: "error", message: reason })),
          },
          go ? "opencode-go" : null,
        ),
      );
    },
    closed: (feed) => {
      open.get(feed)?.();
      open.delete(feed);
    },
  });
  return store;
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

function receive(store: SourceStore<LimitsFeed, Reading>, feed: LimitsFeed, message: LimitsStreamMessage) {
  if (message?.type === "error") {
    store.set(feed, () => ({ kind: "error", message: message.error.message }));
    return;
  }
  // Checked rather than trusted, because this is rendered on every open card at once: a body
  // without `vendors` would otherwise throw inside the render below and take the whole session
  // card down with it, not just the meter. Named, not swallowed.
  const vendors = normalize(message?.report);
  store.set(feed, () =>
    vendors ? { kind: "ready", vendors } : { kind: "error", message: "limits response carried no vendors" },
  );
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
  vendor: QuotaVendorId | null = null,
): LimitsState {
  const reading = useSourceStore(vendor === "opencode-go" ? goLimits : limits, feed ?? NO_FEED);

  return useMemo<LimitsState>(() => {
    if (reading.kind !== "ready") return reading;
    // One vendor's windows, where the caller names one. Both vendors meter five hours, so a Claude
    // card showing Codex's 5h beside its own would be two chips reading the same name at different
    // numbers -- a surface that looks broken and is worse than that, because either could be read
    // as the one about to stop you.
    const vendors = vendor ? reading.vendors.filter((each) => each.vendor === vendor) : reading.vendors;
    const quotas = vendors.flatMap((each) => each.quotas);
    const unavailable = vendors.find((each) => typeof each.unavailable === "string")?.unavailable;
    return unavailable !== undefined && quotas.length === 0
      ? { kind: "ready", quotas, unavailable }
      : { kind: "ready", quotas };
  }, [reading, vendor]);
}
