import { useCallback, useMemo } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import type { StaleClaudeSessions, StaleSessionRestartResult } from "@agentdesk/agent-feed-wire";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import { machineKey } from "@/features/bots/botMachines";
import { useNotify } from "@/hooks/useNotify";

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

interface StaleSessionsState {
  views: ReadonlyMap<string, StaleSessionsView>;
  actions: ReadonlyMap<string, StaleSessionsAction>;
  /**
   * Whether the reader has asked for the lists, and which machines have been read since. The live
   * index names the peers a moment after the page mounts, and a peer can come online at any time:
   * a machine that joins after the reader asked is read when it arrives, rather than sitting on
   * "Reading sessions" for a request nobody made.
   */
  asked: boolean;
  read: ReadonlySet<string>;
  restarting: boolean;
}

/**
 * Held outside React, once for the page, rather than in a hook the app calls. The Profile row is
 * drawn by every sidebar mount (the pinned rail, the hover preview, the phone drawer), and the
 * lists and a restart still running have to be one answer that outlives any of them. It used to be
 * hook state lifted into `App` for that reason, which made every edit to this file an edit to the
 * Feed tab's own hooks: a changed hook list there is React's "Should have a queue" across the whole
 * tab. Here the logic is plain functions, and a reader subscribes from inside its own boundary.
 */
const store = createStore<StaleSessionsState>(() => ({
  views: new Map(),
  actions: new Map(),
  asked: false,
  read: new Set(),
  restarting: false,
}));

function setView(key: string, view: (current: StaleSessionsView | undefined) => StaleSessionsView): void {
  store.setState((state) => ({ views: new Map(state.views).set(key, view(state.views.get(key))) }));
}

function setAction(key: string, action: StaleSessionsAction): void {
  store.setState((state) => ({ actions: new Map(state.actions).set(key, action) }));
}

function loadMachine(machine: StaleSessionsMachine): void {
  const key = machineKey(machine);
  store.setState((state) => ({ read: new Set(state.read).add(key) }));
  // A list already on screen stays while the new one comes, rather than blinking to a spinner.
  setView(key, (current) => (current?.kind === "ready" ? current : { kind: "loading" }));
  void machine.feed.staleSessions().then(
    (stale) => setView(key, () => ({ kind: "ready", stale })),
    (error: unknown) => setView(key, () => ({ kind: "failed", message: messageOf(error) })),
  );
}

function loadAll(all: readonly StaleSessionsMachine[]): void {
  store.setState({ asked: true });
  for (const machine of all) loadMachine(machine);
}

function loadArrivals(all: readonly StaleSessionsMachine[]): void {
  const { asked, read } = store.getState();
  if (!asked) return;
  for (const machine of all) {
    if (!read.has(machineKey(machine))) loadMachine(machine);
  }
}

function restartOn(
  all: readonly StaleSessionsMachine[],
  sessionIdsByMachine: ReadonlyMap<string, readonly string[]>,
): void {
  const asked = all.filter((machine) => (sessionIdsByMachine.get(machineKey(machine))?.length ?? 0) > 0);
  if (store.getState().restarting || asked.length === 0) return;
  store.setState({ restarting: true });
  const runs = asked.map((machine) => {
    const key = machineKey(machine);
    const sessionIds = sessionIdsByMachine.get(key)!;
    setAction(key, { kind: "restarting", count: sessionIds.length });
    return machine.feed
      .restartStaleSessions(sessionIds)
      .then(
        (results) => setAction(key, { kind: "done", results }),
        (error: unknown) => setAction(key, { kind: "failed", message: messageOf(error) }),
      )
      .finally(() => loadMachine(machine));
  });
  void Promise.all(runs).finally(() => store.setState({ restarting: false }));
}

/** Back to a page that has asked nothing, for a test that needs a clean store. */
export function resetStaleSessions(): void {
  store.setState(store.getInitialState(), true);
}

/**
 * The sessions on every machine that a restart would bring onto the current launch flags or CLI.
 *
 * Every machine, not just the one the tab bar points at, because the sessions behind are spread
 * across all of them and the reader wants them brought up together. Each machine is asked on its
 * own sidecar and answers on its own: one that is unreachable says so in its own section while the
 * others list and restart as usual. Read again after every restart, which is what changed it.
 */
export function useStaleSessions(all: readonly StaleSessionsMachine[]): StaleSessionsHandle {
  const views = useStore(store, (state) => state.views);
  const actions = useStore(store, (state) => state.actions);

  // A machine that joins is read once the reader has asked for the list at all.
  useNotify(all, loadArrivals);

  const load = useCallback(() => loadAll(all), [all]);
  const restart = useCallback(
    (sessionIdsByMachine: ReadonlyMap<string, readonly string[]>) => restartOn(all, sessionIdsByMachine),
    [all],
  );
  const machines = useMemo(
    () =>
      all.map((machine) => {
        const key = machineKey(machine);
        return {
          key,
          label: machine.label,
          view: views.get(key) ?? { kind: "idle" as const },
          action: actions.get(key) ?? { kind: "none" as const },
        };
      }),
    [all, views, actions],
  );
  return { machines, load, restart };
}
