"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ParkPlanResponse,
  ParkReport,
  ParkRestoreReport,
  ParkStateResponse,
} from "@agentdesk/agent-feed-wire";
import type { SidecarDataSource } from "../activity-feed/data-source/SidecarDataSource";

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
  /** False when this machine has no yabai, which hides the menu entry entirely. */
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
  "fetchParkState" | "fetchParkPlan" | "park" | "restorePark"
>;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The Desktop Park panel's data.
 *
 * Availability is probed once by asking for state, the same shape as the usage
 * feature's config probe: whether this machine can park windows is a property of
 * the machine, not of the moment. A 503 from the sidecar means no yabai, and the
 * entry stays hidden rather than offering something that cannot work.
 *
 * State and plan are fetched together and always as a pair. A plan describes the
 * state it was computed from, and showing one beside a newer other would invite
 * someone to press Park against a layout that has already moved.
 */
export function useDesktopPark(feed: ParkDataSource): DesktopParkHandle {
  const [available, setAvailable] = useState(false);
  const [view, setView] = useState<ParkView>({ kind: "idle" });
  const [action, setAction] = useState<ParkAction>({ kind: "none" });
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(() => {
    setView((current) => (current.kind === "ready" ? current : { kind: "loading" }));
    void Promise.all([feed.fetchParkState(), feed.fetchParkPlan()]).then(
      ([state, plan]) => {
        if (!mounted.current) return;
        setAvailable(true);
        setView({ kind: "ready", state, plan });
      },
      (error: unknown) => {
        if (!mounted.current) return;
        setView({ kind: "error", message: messageOf(error) });
      },
    );
  }, [feed]);

  // The availability probe. Cheap: one yabai query, no windows touched.
  useEffect(() => {
    let cancelled = false;
    void feed.fetchParkState().then(
      () => {
        if (!cancelled) setAvailable(true);
      },
      () => {
        if (!cancelled) setAvailable(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [feed]);

  const run = useCallback(
    (what: "park" | "restore") => {
      if (busy) return;
      setBusy(true);
      setAction({ kind: "running", what });
      const work = what === "park" ? feed.park() : feed.restorePark();
      void work.then(
        (report) => {
          if (!mounted.current) return;
          setAction(
            what === "park"
              ? { kind: "parked", report: report as ParkReport }
              : { kind: "restored", report: report as ParkRestoreReport },
          );
          setBusy(false);
          // The layout it was showing is now wrong by construction, so re-read
          // rather than leaving a stale plan under a fresh result.
          load();
        },
        (error: unknown) => {
          if (!mounted.current) return;
          setAction({ kind: "failed", what, message: messageOf(error) });
          setBusy(false);
        },
      );
    },
    [busy, feed, load],
  );

  return {
    available,
    view,
    action,
    load,
    park: useCallback(() => run("park"), [run]),
    restore: useCallback(() => run("restore"), [run]),
    busy,
  };
}
