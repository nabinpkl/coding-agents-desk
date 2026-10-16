import { useCallback, useEffect, useRef, useState } from "react";
import type { StaleClaudeSessions, StaleSessionRestartResult } from "@agentdesk/agent-feed-wire";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";

export type StaleSessionsSource = Pick<SidecarDataSource, "staleSessions" | "restartStaleSessions">;

export type StaleSessionsView =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; stale: StaleClaudeSessions }
  | { kind: "failed"; message: string };

export type StaleSessionsAction =
  | { kind: "none" }
  | { kind: "restarting"; count: number }
  | { kind: "done"; results: StaleSessionRestartResult[] }
  | { kind: "failed"; message: string };

export interface StaleSessionsHandle {
  view: StaleSessionsView;
  action: StaleSessionsAction;
  /** Reads the list. Called when the modal opens, never on mount: nothing reads it until then. */
  load: () => void;
  restart: (sessionIds: readonly string[]) => void;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The sessions on this machine that a restart would bring onto the current launch flags or CLI.
 *
 * Owned by the app beside Usage and Desktop park, for the reason they are: three sidebar mounts
 * share one Profile menu, and a list read by each would be three lists. Read again after every
 * restart, because the restart is what changed it.
 */
export function useStaleSessions(feed: StaleSessionsSource): StaleSessionsHandle {
  const [view, setView] = useState<StaleSessionsView>({ kind: "idle" });
  const [action, setAction] = useState<StaleSessionsAction>({ kind: "none" });
  const mounted = useRef(true);
  const restarting = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(() => {
    // A list already on screen stays while the new one comes, rather than blinking to a spinner.
    setView((current) => (current.kind === "ready" ? current : { kind: "loading" }));
    void feed.staleSessions().then(
      (stale) => {
        if (mounted.current) setView({ kind: "ready", stale });
      },
      (error: unknown) => {
        if (mounted.current) setView({ kind: "failed", message: messageOf(error) });
      },
    );
  }, [feed]);

  const restart = useCallback((sessionIds: readonly string[]) => {
    if (restarting.current || sessionIds.length === 0) return;
    restarting.current = true;
    setAction({ kind: "restarting", count: sessionIds.length });
    void feed.restartStaleSessions(sessionIds).then(
      (results) => {
        if (mounted.current) setAction({ kind: "done", results });
      },
      (error: unknown) => {
        if (mounted.current) setAction({ kind: "failed", message: messageOf(error) });
      },
    ).finally(() => {
      restarting.current = false;
      if (mounted.current) load();
    });
  }, [feed, load]);

  return { view, action, load, restart };
}
