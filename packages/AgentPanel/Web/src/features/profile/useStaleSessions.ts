import { useCallback, useEffect, useRef, useState } from "react";
import type { StaleClaudeSessions, StaleSessionRestartResult } from "@agentdesk/agent-feed-wire";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import { machineKey } from "@/features/bots/botMachines";

export type StaleSessionsSource = Pick<SidecarDataSource, "staleSessions" | "restartStaleSessions">;

/** A machine whose sessions can be listed and restarted: the shape `ShellMachines.all` already has. */
export interface StaleSessionsMachine {
  readonly id?: string;
  readonly label: string;
  readonly feed: StaleSessionsSource;
}

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

/** One machine's list and the outcome of its last restart. */
export interface MachineStaleSessions {
  key: string;
  label: string;
  view: StaleSessionsView;
  action: StaleSessionsAction;
}

export interface StaleSessionsHandle {
  /** Every machine, home first, in the order the canvas reads them. */
  machines: MachineStaleSessions[];
  /** Reads every machine's list. Called when the modal opens, never on mount. */
  load: () => void;
  /** Restarts, on each machine, the sessions named for it. Machines left out are not asked. */
  restart: (sessionIdsByMachine: ReadonlyMap<string, readonly string[]>) => void;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The sessions on every machine that a restart would bring onto the current launch flags or CLI.
 *
 * Every machine, not just the one the tab bar points at, because the sessions behind are spread
 * across all of them and the reader wants them brought up together. Each machine is asked on its
 * own sidecar and answers on its own: one that is unreachable says so in its own section while the
 * others list and restart as usual. Owned by the app beside Usage and Desktop park, because three
 * sidebar mounts share one Profile menu. Read again after every restart, which is what changed it.
 */
export function useStaleSessions(all: readonly StaleSessionsMachine[]): StaleSessionsHandle {
  const [views, setViews] = useState<ReadonlyMap<string, StaleSessionsView>>(new Map());
  const [actions, setActions] = useState<ReadonlyMap<string, StaleSessionsAction>>(new Map());
  const mounted = useRef(true);
  const restarting = useRef(false);
  /**
   * Whether the reader has asked for the lists, and which machines have been read since. The live
   * index names the peers a moment after the page mounts, and a peer can come online at any time:
   * a machine that joins after the reader asked is read when it arrives, rather than sitting on
   * "Reading sessions" for a request nobody made.
   */
  const asked = useRef(false);
  const read = useRef(new Set<string>());

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const setView = useCallback((key: string, view: (current: StaleSessionsView | undefined) => StaleSessionsView) => {
    setViews((current) => new Map(current).set(key, view(current.get(key))));
  }, []);
  const setAction = useCallback((key: string, action: StaleSessionsAction) => {
    setActions((current) => new Map(current).set(key, action));
  }, []);

  const loadMachine = useCallback((machine: StaleSessionsMachine) => {
    const key = machineKey(machine);
    read.current.add(key);
    // A list already on screen stays while the new one comes, rather than blinking to a spinner.
    setView(key, (current) => (current?.kind === "ready" ? current : { kind: "loading" }));
    void machine.feed.staleSessions().then(
      (stale) => {
        if (mounted.current) setView(key, () => ({ kind: "ready", stale }));
      },
      (error: unknown) => {
        if (mounted.current) setView(key, () => ({ kind: "failed", message: messageOf(error) }));
      },
    );
  }, [setView]);

  const load = useCallback(() => {
    asked.current = true;
    for (const machine of all) loadMachine(machine);
  }, [all, loadMachine]);

  useEffect(() => {
    if (!asked.current) return;
    for (const machine of all) {
      if (!read.current.has(machineKey(machine))) loadMachine(machine);
    }
  }, [all, loadMachine]);

  const restart = useCallback((sessionIdsByMachine: ReadonlyMap<string, readonly string[]>) => {
    const asked = all.filter((machine) => (sessionIdsByMachine.get(machineKey(machine))?.length ?? 0) > 0);
    if (restarting.current || asked.length === 0) return;
    restarting.current = true;
    const runs = asked.map((machine) => {
      const key = machineKey(machine);
      const sessionIds = sessionIdsByMachine.get(key)!;
      setAction(key, { kind: "restarting", count: sessionIds.length });
      return machine.feed.restartStaleSessions(sessionIds).then(
        (results) => {
          if (mounted.current) setAction(key, { kind: "done", results });
        },
        (error: unknown) => {
          if (mounted.current) setAction(key, { kind: "failed", message: messageOf(error) });
        },
      ).finally(() => {
        if (mounted.current) loadMachine(machine);
      });
    });
    void Promise.all(runs).finally(() => {
      restarting.current = false;
    });
  }, [all, loadMachine, setAction]);

  const machines = all.map((machine) => {
    const key = machineKey(machine);
    return {
      key,
      label: machine.label,
      view: views.get(key) ?? { kind: "idle" as const },
      action: actions.get(key) ?? { kind: "none" as const },
    };
  });
  return { machines, load, restart };
}
