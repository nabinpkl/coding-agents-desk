"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { UsageQuota } from "@agentdesk/agent-feed-wire";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";

/**
 * How long a reading is reused before the next open re-reads it.
 *
 * The meters themselves move only when a request comes back, so this is not about precision; it
 * is about not asking the sidecar again for something a reader is opening and closing while
 * watching one number. Their own age is on screen either way, so a reader is never shown a stale
 * figure without being told it is stale.
 */
const REUSE_MS = 30_000;

export type LimitsState =
  | { kind: "idle" }
  | { kind: "loading" }
  /** Every window every vendor publishes, already ordered by the sidecar. Empty is a real answer. */
  | { kind: "ready"; quotas: UsageQuota[] }
  | { kind: "error"; message: string };

export interface LimitsHandle {
  state: LimitsState;
  /** Reads the meters if the last reading has aged out. Safe to call on every open. */
  load: () => void;
}

/**
 * The rate-limit meters, read on demand.
 *
 * On demand rather than on mount, and per surface rather than globally: the meters are wanted by
 * a popover that most readers never open, and a panel showing eight session cards would otherwise
 * make eight identical reads at load for a number none of them is displaying yet.
 */
export function useLimits(feed: Pick<SidecarDataSource, "fetchLimits"> | null): LimitsHandle {
  const [state, setState] = useState<LimitsState>({ kind: "idle" });
  const readAt = useRef(0);
  const inFlight = useRef(false);
  // Set on unmount, so a read that comes back after the popover closed does not set state on a
  // component that is gone.
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const load = useCallback(() => {
    // No sidecar to ask. The surface that has one always passes it; this keeps a readout that is
    // rendered without one from throwing rather than from quietly inventing a meter.
    if (!feed || inFlight.current) return;
    const now = Date.now();
    if (now - readAt.current < REUSE_MS) return;
    inFlight.current = true;
    // A reading already on screen stays while the next one is fetched: it was true when it
    // arrived, and replacing it with a spinner would blank the only numbers the popover is for.
    setState((current) => (current.kind === "ready" ? current : { kind: "loading" }));
    void feed.fetchLimits().then(
      (report) => {
        inFlight.current = false;
        readAt.current = Date.now();
        if (live.current) {
          setState({ kind: "ready", quotas: report.vendors.flatMap((vendor) => vendor.quotas) });
        }
      },
      (error: unknown) => {
        inFlight.current = false;
        // Stamped like a success, so a failure backs off instead of being retried immediately.
        // Measured on a Canvas card against a sidecar that did not have the route yet: without
        // this the open popover asked again on every render and the page took dozens of 404s in
        // a few seconds. The reader waits out one reuse window for a retry; the alternative is a
        // surface that hammers a sidecar precisely when it is unwell.
        readAt.current = Date.now();
        if (!live.current) return;
        setState({ kind: "error", message: error instanceof Error ? error.message : String(error) });
      },
    );
  }, [feed]);

  return { state, load };
}
