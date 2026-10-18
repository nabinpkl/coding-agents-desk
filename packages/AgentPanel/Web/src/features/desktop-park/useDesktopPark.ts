"use client";

import { useCallback } from "react";
import type { ParkPlanResponse, ParkReport, ParkRestoreReport, ParkStateResponse } from "@agentdesk/agent-feed-wire";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import { createSourceStore, useSourceStore } from "@/features/activity-feed/data-source/sourceStore";

export type ParkView =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; state: ParkStateResponse; plan: ParkPlanResponse }
  | { kind: "error"; message: string };

/** What the last mutation did, kept on screen until the next one replaces it. */
export type ParkAction =
  | { kind: "none" }
  | { kind: "running"; what: "park" | "restore" }
  | { kind: "parked"; report: ParkReport }
  | { kind: "restored"; report: ParkRestoreReport }
  | { kind: "failed"; what: "park" | "restore"; message: string };

export interface DesktopParkHandle {
  /** False when this machine has no window manager to drive. Disables the entry. */
  available: boolean;
  view: ParkView;
  action: ParkAction;
  /** Reads state and plan together. Safe to call repeatedly. */
  load: () => void;
  park: () => void;
  restore: () => void;
  busy: boolean;
}

export type ParkDataSource = Pick<
  SidecarDataSource,
  "fetchParkState" | "fetchParkPlan" | "park" | "restorePark" | "fetchConfig"
>;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface ParkEntry {
  available: boolean;
  view: ParkView;
  action: ParkAction;
  busy: boolean;
}

/** Machines whose config has been asked for, so a second reader does not ask again. */
const asked = new WeakSet<ParkDataSource>();

const store = createSourceStore<ParkDataSource, ParkEntry>({
  initial: () => ({ available: false, view: { kind: "idle" }, action: { kind: "none" }, busy: false }),
  opened: readAvailability,
});

function patch(feed: ParkDataSource, change: Partial<ParkEntry>): void {
  store.set(feed, (entry) => ({ ...entry, ...change }));
}

/**
 * Availability comes from the config read the panel already makes, not from a probe of our own.
 *
 * A probe fired on mount competes for one of the few concurrent relay slots at the busiest moment
 * of startup, and it lost: the host logged `relay refused /api/park/state: 4 concurrent requests
 * already in flight`, which was then reported to the user as "no yabai". A failed request is not an
 * absent capability, and the fix is to stop asking a second time for something a process-global
 * fact can carry.
 */
function readAvailability(feed: ParkDataSource): void {
  if (asked.has(feed)) return;
  asked.add(feed);
  void feed.fetchConfig().then(
    (config) => patch(feed, { available: config.parkAvailable === true }),
    // A config read that fails means the sidecar is not answering at all, and the panel's own
    // connection errors are what the viewer sees. The next reader asks again.
    () => asked.delete(feed),
  );
}

function load(feed: ParkDataSource): void {
  store.set(feed, (entry) => ({ ...entry, view: entry.view.kind === "ready" ? entry.view : { kind: "loading" } }));
  void Promise.all([feed.fetchParkState(), feed.fetchParkPlan()]).then(
    ([state, plan]) => patch(feed, { available: true, view: { kind: "ready", state, plan } }),
    (error: unknown) => patch(feed, { view: { kind: "error", message: messageOf(error) } }),
  );
}

function run(feed: ParkDataSource, what: "park" | "restore"): void {
  if (store.get(feed).busy) return;
  patch(feed, { busy: true, action: { kind: "running", what } });
  const work = what === "park" ? feed.park() : feed.restorePark();
  void work.then(
    (report) => {
      patch(feed, {
        busy: false,
        action:
          what === "park"
            ? { kind: "parked", report: report as ParkReport }
            : { kind: "restored", report: report as ParkRestoreReport },
      });
      // The layout it was showing is now wrong by construction, so re-read rather than leaving a
      // stale plan under a fresh result.
      load(feed);
    },
    (error: unknown) => patch(feed, { busy: false, action: { kind: "failed", what, message: messageOf(error) } }),
  );
}

/**
 * The Desktop Park panel's data.
 *
 * Availability rides the config read the panel already makes, the same way the summarizer's and
 * the usage vendors' do: whether this machine can park windows is a property of the machine, not of
 * the moment, and the panel should not spend a request discovering it.
 *
 * State and plan are fetched together and always as a pair. A plan describes the state it was
 * computed from, and showing one beside a newer other would invite someone to press Park against a
 * layout that has already moved.
 */
export function useDesktopPark(feed: ParkDataSource): DesktopParkHandle {
  const entry = useSourceStore(store, feed);
  const read = useCallback(() => load(feed), [feed]);
  const park = useCallback(() => run(feed, "park"), [feed]);
  const restore = useCallback(() => run(feed, "restore"), [feed]);
  return { ...entry, load: read, park, restore };
}
