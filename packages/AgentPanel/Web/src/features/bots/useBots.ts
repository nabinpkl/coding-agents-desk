import { useCallback, useMemo, useRef, useState } from "react";
import type { BotSessionRef, BotView } from "@agentdesk/agent-feed-wire";
import {
  indexBotMachines,
  indexSessionMachines,
  machineFeedKey,
  machineKey,
  mergeMachineBots,
  type BotMachine,
} from "@/features/bots/botMachines";
import { streamRetry, type StreamRetry } from "@/features/activity-feed/transport/streamRetry";
import { useLatestRef } from "@/hooks/useLatestRef";
import { useSubscription } from "@/hooks/useSubscription";

/** A machine whose Bot stream is failing. */
export interface MachineError {
  label: string;
  reason: string;
  /**
   * Its last snapshot is still on the canvas. A stream drops on every sidecar restart and its
   * Bots stay drawn as they were, so the reader is told it is reconnecting -- not that the
   * machine's Bots are gone, which is what the same failure means before anything arrived.
   */
  held: boolean;
}

/** Which machine each Bot and each held session is on, as of one roster. */
export interface BotMachineIndex {
  bots: readonly BotView[];
  /** By Bot id. */
  bot: ReadonlyMap<string, BotMachine>;
  /** By `source:sessionId`. */
  session: ReadonlyMap<string, BotMachine>;
}

export interface BotRosterState {
  /** Every machine's Bots as one roster, in the order `mergeMachineBots` fixes. */
  bots: BotView[];
  /**
   * Which machine each Bot is on, for anything that decides it while rendering. It changes with
   * the roster, so a memo keyed on it sees a Bot that has just arrived.
   */
  machineIndex: BotMachineIndex;
  /**
   * Which sidecar a Bot's commands and transcripts must go to, for a command. Undefined for an
   * unknown id. One identity for the life of the panel, reading the roster as last committed, so
   * not for render: a Bot that arrives in this render is not in it yet. Render reads
   * `machineIndex`.
   */
  machineOf: (botId: string) => BotMachine | undefined;
  /**
   * The same, for a command addressed at a session rather than at the Bot holding it: the Bot's
   * machine, else the machine whose Sessions list showed it (`noteListed`).
   */
  machineOfSession: (ref: BotSessionRef) => BotMachine | undefined;
  /**
   * Records that a machine's Sessions list holds these sessions. Called by the lists as rows arrive.
   *
   * A session on no Bot used to be the shell's own machine's by definition, because the only list
   * that showed one was that machine's. The Sessions view lists every machine's now, and a session
   * picked there is renamed, forked and moved onto the canvas by commands handed a `SessionSummary`
   * and nothing else (`botFeeds.forSession`), which would otherwise all reach the shell's machine
   * and come back "no such session".
   */
  noteListed: (machine: { readonly id?: string }, sessions: readonly BotSessionRef[]) => void;
  /** The roster as it stands when called, for a command that has to look past its own Bot. */
  botsNow: () => readonly BotView[];
  /** Nothing has arrived and nothing has failed: the canvas has no answer yet, good or bad. */
  loading: boolean;
  /** No machine can be read at all. Set only when there is nothing to show, never as a warning. */
  error: string | null;
  /**
   * Every machine currently has a snapshot.
   *
   * The one thing a merged roster needs that a single one did not. `useCanvasRoster` prunes stored
   * open keys against the Bots it can see, and with one sidecar "not loading and no error" meant
   * the roster was known. With two it does not: a reader whose oracle peer is asleep would have
   * every oracle card pruned out of their store by a canvas that was perfectly healthy about the
   * Mac. Pruning waits for all of them or it does not happen.
   */
  settled: boolean;
  /**
   * The machines that are failing, while others are not.
   *
   * Named rather than folded into `error`, because a declared peer that is unreachable must be
   * VISIBLE -- it looks exactly like a peer with no Bots on it -- without blanking a canvas that is
   * otherwise fine.
   */
  machineErrors: MachineError[];
}

function withoutAbsent<T>(current: ReadonlyMap<string, T>, machines: readonly BotMachine[]): ReadonlyMap<string, T> {
  const live = new Set(machines.map(machineKey));
  if ([...current.keys()].every((key) => live.has(key))) return current;
  return new Map([...current].filter(([key]) => live.has(key)));
}

/**
 * One app-scoped subscription per machine, merged into the single roster every surface reads.
 *
 * Each machine retries on its OWN clock. A shared retry would reopen the healthy machine's stream
 * every time the unreachable one backed off, and the sidecar's stream budget is finite (see
 * `subscribeInventory` for what ran out of it first).
 *
 * Keyed on each machine's id AND its data source rather than on the array, so a fresh array of the
 * same machines does not resubscribe, and a data source rebuilt under an unchanged id does. The
 * second is what an edit to the data source does in development: `main.tsx` builds it afresh
 * instead of reloading the page, and a roster still subscribed through the old one would keep
 * running the code that was just replaced. The roster it last had stays drawn while it reopens.
 */
export function useBots(machines: readonly BotMachine[]): BotRosterState {
  const [snapshots, setSnapshots] = useState<ReadonlyMap<string, readonly BotView[]>>(new Map());
  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(new Map());
  // Read as the subscriptions open rather than keyed on, so they survive a re-render that only
  // rebuilt the array.
  const machinesRef = useLatestRef(machines);
  const signature = machines.map(machineFeedKey).join("\0");

  // One stream per machine, reopened when the set of machines or any one's data source changes.
  useSubscription(signature, () => {
    const current = machinesRef.current;
    const stops = new Map<string, () => void>();
    const retries = new Map<string, StreamRetry>();
    let live = true;

    const open = (machine: BotMachine): void => {
      const key = machineKey(machine);
      stops.set(
        key,
        machine.feed.subscribeBots(
          (snapshot) => {
            if (!live) return;
            retries.get(key)?.succeeded();
            setSnapshots((previous) => new Map(previous).set(key, snapshot.bots));
            setErrors((previous) => {
              if (!previous.has(key)) return previous;
              const next = new Map(previous);
              next.delete(key);
              return next;
            });
          },
          (reason) => {
            if (!live) return;
            setErrors((previous) => new Map(previous).set(key, reason));
            stops.get(key)?.();
            stops.delete(key);
            retries.get(key)?.failed();
          },
        ),
      );
    };

    for (const machine of current) {
      retries.set(
        machineKey(machine),
        streamRetry(`Bots on ${machine.label}`, () => {
          if (live) open(machine);
        }),
      );
      open(machine);
    }
    // A machine that is no longer declared must take its Bots with it, or a peer removed from the
    // picker leaves a card on the canvas that nothing can ever act on.
    setSnapshots((previous) => withoutAbsent(previous, current));
    setErrors((previous) => withoutAbsent(previous, current));

    return () => {
      live = false;
      for (const stop of stops.values()) stop();
      for (const retry of retries.values()) retry.stop();
    };
  });

  const rosters = useMemo(
    () =>
      machines.flatMap((machine) => {
        const bots = snapshots.get(machineKey(machine));
        return bots === undefined ? [] : [{ machine, bots }];
      }),
    [machines, snapshots],
  );
  const bots = useMemo(() => mergeMachineBots(rosters), [rosters]);
  const machineIndex = useMemo<BotMachineIndex>(
    () => ({ bots, bot: indexBotMachines(rosters), session: indexSessionMachines(rosters) }),
    [bots, rosters],
  );
  // The resolvers read the index through a ref, so they keep ONE identity for the life of the
  // panel.
  //
  // Two things follow, and both are wanted. Every command callback that closes over them stays
  // stable while the Bot stream pushes -- otherwise a snapshot every few seconds would rebuild the
  // whole command surface and every prop on the canvas with it. And a command resolves against the
  // roster as it is when the button is PRESSED rather than as it was when the button rendered,
  // which is the correct answer for a Bot that moved between the two.
  const committed = useLatestRef(machineIndex);
  const machineOf = useCallback((botId: string) => committed.current.bot.get(botId), [committed]);
  // Which machine listed each session, by `source:sessionId`, as a machine key: written as rows
  // arrive and read when a command runs, so nothing renders from it. A key rather than the machine,
  // so a data source swapped in under the same id is the one a command reaches.
  const listedOn = useRef(new Map<string, string>());
  const noteListed = useCallback(
    (machine: { readonly id?: string }, sessions: readonly BotSessionRef[]) => {
      for (const session of sessions)
        listedOn.current.set(`${session.source}:${session.sessionId}`, machineKey(machine));
    },
    [listedOn],
  );
  const machineOfSession = useCallback(
    (ref: BotSessionRef) => {
      const key = `${ref.source}:${ref.sessionId}`;
      const held = committed.current.session.get(key);
      if (held) return held;
      const listed = listedOn.current.get(key);
      return listed === undefined ? undefined : machinesRef.current.find((machine) => machineKey(machine) === listed);
    },
    [committed, listedOn, machinesRef],
  );
  const botsNow = useCallback(() => committed.current.bots, [committed]);
  const machineErrors = useMemo(
    () =>
      machines.flatMap((machine) => {
        const key = machineKey(machine);
        const reason = errors.get(key);
        return reason === undefined ? [] : [{ label: machine.label, reason, held: snapshots.has(key) }];
      }),
    [machines, errors, snapshots],
  );

  return {
    bots,
    machineIndex,
    machineOf,
    machineOfSession,
    noteListed,
    botsNow,
    loading: snapshots.size === 0 && errors.size === 0,
    error:
      snapshots.size === 0 && machineErrors.length > 0
        ? machineErrors.map(({ label, reason }) => `${label}: ${reason}`).join("; ")
        : null,
    settled: machines.length > 0 && rosters.length === machines.length,
    machineErrors,
  };
}
