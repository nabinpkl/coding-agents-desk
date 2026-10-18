// The terminal canvas's shell: every machine's snapshots, the grouping over them, the reader's
// arrangement, and the two commands that change what is running.
//
// One hook because the pieces are one decision made several times, the way `useBotMachines` is
// for the Bot canvas: the grouping, the hues, the open keys and the kill all resolve "which
// sidecar owns this directory", and spread across the shell one of them would be missed -- which
// is exactly what happened over there, where the commands were routed and the transcript was
// not, so a peer's card ran its menu against the right sidecar and read from the wrong one.
//
// The snapshots are read once per mount and on refresh rather than streamed, the same trade the
// wall made: a session appearing is a thing somebody just did in a terminal, and a listing
// stream would cost a connection per machine on an origin that holds about six. The Bot roster
// rides its existing subscription, which the canvas is already paying for wherever it is mounted.

import { useCallback, useMemo, useState } from "react";
import type { TmuxSessionSummary } from "@agentdesk/agent-feed-wire";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import { machineFeedKey, machineKey, type BotMachine } from "@/features/bots/botMachines";
import { loadHiddenMachines, storeHiddenMachines } from "@/features/bots/canvas/botCanvasPreferences";
import { useBots } from "@/features/bots/useBots";
import {
  groupTerminalsByDirectory,
  parseTerminalChildKey,
  terminalChildKey,
  terminalPaneKey,
  terminalSessionNameError,
  terminalWindowKey,
  type TerminalGrouping,
  type TerminalParentGroup,
} from "@/features/terminal/canvas/terminalGroups";
import {
  loadHiddenTerminalParents,
  loadOffStripTerminalChildren,
  loadOpenTerminalChildren,
  loadTerminalActiveOnly,
  loadTerminalRoom,
  loadTerminalZoomMode,
  storeHiddenTerminalParents,
  storeOffStripTerminalChildren,
  storeOpenTerminalChildren,
  storeTerminalActiveOnly,
  storeTerminalRoom,
  storeTerminalZoomMode,
} from "@/features/terminal/canvas/terminalCanvasPreferences";
import { terminalParentHues, terminalParentRanks } from "@/features/terminal/canvas/terminalSurface";
import { DEFAULT_TILE_GRID } from "@/features/terminal/terminalTileSize";
import { usePersistentState } from "@/hooks/state/usePersistentState";
import { useSubscription } from "@/hooks/useSubscription";
import { runWithFinally } from "@/hooks/state/runWithFinally";

/** One machine's tmux listing and workspace roots, as the last load left them. */
interface MachineSnapshot {
  sessions: TmuxSessionSummary[];
  workspaceRoots: string[];
}

export function useTerminalCanvas(
  /** The sidecar this shell is pointed at, home when the embedder names no machines. */
  feed: SidecarDataSource,
  /** Every machine the embedder can reach, or absent for one that reaches only its own. */
  machines: readonly BotMachine[] | undefined,
) {
  // One machine, unlabelled, when the embedder names none -- and when it names none YET. An empty
  // list is the ordinary first render, where the live index is a moment behind the mount, and
  // treating it as "no machines" would leave the canvas loading forever. The same fallback
  // `useBotMachines` keeps, for the same first render.
  const all = useMemo<readonly BotMachine[]>(
    () => (machines && machines.length > 0 ? machines : [{ label: "this machine", feed }]),
    [machines, feed],
  );
  const roster = useBots(all);
  const [snapshots, setSnapshots] = useState<ReadonlyMap<string, MachineSnapshot>>(new Map());
  const [snapshotErrors, setSnapshotErrors] = useState<ReadonlyMap<string, string>>(new Map());
  const [revision, setRevision] = useState(0);

  /**
   * One load of every machine's listing, settling the states it writes.
   *
   * A callback rather than only the subscription's body, because the add and kill flows await the
   * listing that follows their command: opening the newborn key only once the grouping holds it
   * means the prune below can never close what was just opened before it stands on the strip.
   */
  const reload = useCallback(async (current: readonly BotMachine[], live: { on: boolean }): Promise<void> => {
    // A `for` loop rather than `current.map(async ...)`: the map form never invoked its
    // callback here -- real array, real `Array.prototype.map`, zero calls, no error -- while an
    // otherwise identical construct works in isolation. Not understood, so not used; the loop
    // below was verified to iterate in this file. If the map form comes back, prove it calls
    // `listTmuxSessions` in `TerminalCanvasShell.test.tsx` before trusting it.
    const load = async (machine: BotMachine): Promise<void> => {
      const key = machineKey(machine);
      try {
        const [sessions, workspaces] = await Promise.all([
          machine.feed.listTmuxSessions(),
          // An empty roster rather than a failed machine: a sidecar that answers tmux but not
          // the workspace list still has sessions to stand, and the Bot directories below still
          // name parents.
          machine.feed.listWorkspaces().catch(() => []),
        ]);
        if (!live.on) return;
        setSnapshots((previous) => new Map(previous).set(key, {
          sessions,
          workspaceRoots: workspaces.map((workspace) => workspace.root),
        }));
        setSnapshotErrors((previous) => {
          if (!previous.has(key)) return previous;
          const next = new Map(previous);
          next.delete(key);
          return next;
        });
      } catch (error) {
        if (!live.on) return;
        const reason = error instanceof Error ? error.message : String(error);
        setSnapshotErrors((previous) => new Map(previous).set(key, reason));
      }
    };
    const jobs: Promise<void>[] = [];
    for (const machine of current) jobs.push(load(machine));
    await Promise.all(jobs);
  }, []);

  // Every machine's listing, read again for each set of machines and on each asked-for refresh. An
  // answer for a set that has since moved on is dropped.
  useSubscription(`${revision}:${all.map(machineFeedKey).join("\u0000")}`, () => {
    const live = { on: true };
    void reload(all, live);
    // A machine that is no longer declared takes its snapshot with it, or a peer removed from
    // the index leaves cards on the canvas that nothing can ever act on.
    setSnapshots((previous) => withoutAbsent(previous, all));
    setSnapshotErrors((previous) => withoutAbsent(previous, all));
    return () => {
      live.on = false;
    };
  });

  const refresh = useCallback(() => setRevision((now) => now + 1), []);

  const sources = useMemo(
    () => all.map((machine) => {
      const key = machineKey(machine);
      const snapshot = snapshots.get(key);
      return {
        machineId: machine.id,
        machineLabel: machine.label,
        sessions: snapshot?.sessions ?? [],
        workspaceRoots: snapshot?.workspaceRoots ?? [],
        botDirs: roster.bots
          .filter((bot) => roster.machineIndex.bot.get(bot.botId) === machine)
          .map((bot) => bot.environment.path),
      };
    }),
    [all, snapshots, roster.bots, roster.machineIndex],
  );
  const grouping: TerminalGrouping = useMemo(() => groupTerminalsByDirectory(sources), [sources]);
  const [activeOnly, setActiveOnly] = usePersistentState<boolean>(loadTerminalActiveOnly, storeTerminalActiveOnly);
  // Active-only hides the empty parents -- workspace roots and Bot directories with nothing
  // running in them -- while the hues and ranks below still read the whole roster, so toggling
  // never repaints a face. Residue groups always stand: a pathless session is running work.
  const visibleGrouping: TerminalGrouping = useMemo(() => activeOnly
    ? {
      parents: grouping.parents.filter((parent) => parent.children.length > 0),
      residue: grouping.residue,
    }
    : grouping, [activeOnly, grouping]);
  const identities = useMemo(
    () => [
      ...grouping.parents.map((parent) => ({ key: parent.key, path: parent.path })),
      ...grouping.residue.map((parent) => ({ key: parent.key, path: parent.path })),
    ],
    [grouping],
  );
  const hues = useMemo(() => terminalParentHues(identities), [identities]);
  // The face each parent wears is drawn from the same rank its colour is, so the two agree
  // without either knowing about the other -- the same contract `botCanvasRanks` keeps.
  const ranks = useMemo(() => terminalParentRanks(identities), [identities]);

  // Settled means every machine ANSWERED, not just that the roster is complete for the machines
  // seen so far. Pruning open keys against a partial listing drops the cards of a peer that is
  // a moment behind -- the `known` lesson from `useBotMachines`, which cost a canvas its oracle
  // session on one reload.
  const settled = all.every((machine) => snapshots.has(machineKey(machine)));
  const loading = !settled && snapshotErrors.size === 0;
  const machineErrors = useMemo(
    () => {
      const rosterReasons = new Map(roster.machineErrors.map((entry) => [entry.label, entry.reason]));
      return all.flatMap((machine) => {
        const reason = snapshotErrors.get(machineKey(machine)) ?? rosterReasons.get(machine.label);
        return reason === undefined ? [] : [{ label: machine.label, reason }];
      });
    },
    [all, snapshotErrors, roster.machineErrors],
  );
  const error = !loading && settled === false && machineErrors.length === all.length && all.length > 0
    ? machineErrors[0]!.reason
    : null;

  const [hiddenMachines, setHiddenMachines] = usePersistentState<ReadonlySet<string>>(loadHiddenMachines, storeHiddenMachines);
  const [hiddenParents, setHiddenParents] = usePersistentState<ReadonlySet<string>>(loadHiddenTerminalParents, storeHiddenTerminalParents);
  const [offStripChildren, setOffStripChildren] = usePersistentState<ReadonlySet<string>>(loadOffStripTerminalChildren, storeOffStripTerminalChildren);
  const [openChildren, setOpenChildren] = usePersistentState<ReadonlySet<string>>(loadOpenTerminalChildren, storeOpenTerminalChildren);

  // Drawn whole or drawn at its own size, and how much room the fitted canvas gets to be
  // scrolled around in. The same arrangement the Bot canvas keeps, under this canvas's own
  // keys -- one canvas's fit must never open the other one drawn small.
  const [zoomMode, setZoomMode] = usePersistentState<boolean>(loadTerminalZoomMode, storeTerminalZoomMode);
  const [zoomRoom, setZoomRoom] = usePersistentState<number>(loadTerminalRoom, storeTerminalRoom);

  // A stale open key opens nothing and says nothing about it, so unlike the hidden sets --
  // whose staleness the strip announces -- these are pruned once the listing is whole. Pruned
  // against the grouping rather than the strip, because a child taken off the strip on purpose
  // stays open-capable: hiding is an arrangement, and only death ends it. Compared outside the
  // updater, because the store write beside the set is a side effect and updaters must stay pure.
  const liveKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const parent of [...grouping.parents, ...grouping.residue]) {
      for (const child of parent.children) {
        keys.add(terminalChildKey(parent.machineId, child.name));
        for (const window of child.windowList) {
          keys.add(terminalWindowKey(parent.machineId, child.name, window.index));
          for (const pane of window.panes) {
            keys.add(terminalPaneKey(parent.machineId, child.name, window.index, pane.index));
          }
        }
      }
    }
    return keys;
  }, [grouping]);
  if (settled) {
    const next = new Set(
      [...openChildren].filter((key) => parseTerminalChildKey(key) !== null && liveKeys.has(key)),
    );
    // The setter writes the store; only when something actually went.
    if (next.size !== openChildren.size) setOpenChildren(next);
  }

  const feedFor = useCallback(
    (machineId: string | undefined): SidecarDataSource => (
      all.find((machine) => (machine.id ?? "") === (machineId ?? ""))?.feed ?? feed
    ),
    [all, feed],
  );

  const [addingKeys, setAddingKeys] = useState<ReadonlySet<string>>(new Set());
  const [addErrors, setAddErrors] = useState<ReadonlyMap<string, string>>(new Map());

  /**
   * Starts a shell in this parent's directory under the name the reader chose.
   *
   * The name arrives from the card's or row's naming form, which offers
   * `suggestTerminalSessionName` as the default and validates before sending. The check here
   * is the backstop for a caller that skipped the form: a stale default that collided since
   * the listing arrived would otherwise join that session instead of starting one here.
   */
  const onAddTerminal = useCallback((parent: TerminalParentGroup, session: string) => {
    const name = session.trim();
    // Machine-wide, not just this directory's: names are per-server, so a name standing
    // anywhere on this machine is a join, wherever the form offered it from.
    const standing = [...grouping.parents, ...grouping.residue]
      .filter((each) => (each.machineId ?? "") === (parent.machineId ?? ""))
      .flatMap((each) => each.children.map((child) => child.name));
    const invalid = terminalSessionNameError(name, standing);
    if (invalid) {
      setAddErrors((previous) => new Map(previous).set(parent.key, invalid));
      return;
    }
    setAddingKeys((previous) => new Set(previous).add(parent.key));
    setAddErrors((previous) => {
      if (!previous.has(parent.key)) return previous;
      const next = new Map(previous);
      next.delete(parent.key);
      return next;
    });
    void runWithFinally(async () => {
      try {
        const target = feedFor(parent.machineId);
        // Created and immediately released: the listing reports the session from here on, and a
        // tile the canvas opens joins it the way it joins any other. Holding the attach would
        // steal the pane's one pipe from the tile that is about to open it.
        const descriptor = await target.openTerminal(
          { kind: "tmux-new", session: name, directory: parent.path },
          DEFAULT_TILE_GRID.columns,
          DEFAULT_TILE_GRID.rows,
        );
        await target.closeTerminal(descriptor.terminalId, "detach");
        // Awaited rather than fired: the key below is opened only once the grouping holds it,
        // which is what keeps the prune from closing what was just opened.
        await reload(all, { on: true });
        refresh();
        const key = terminalChildKey(parent.machineId, name);
        setOpenChildren((previous) => {
          const next = new Set(previous).add(key);
          storeOpenTerminalChildren(next);
          return next;
        });
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        setAddErrors((previous) => new Map(previous).set(parent.key, message));
      }
    }, () => {
      setAddingKeys((previous) => {
        const next = new Set(previous);
        next.delete(parent.key);
        return next;
      });
    });
  }, [all, feedFor, grouping, refresh, reload, setOpenChildren]);

  /**
   * Picks a child from the roster, the way the Bot sidebar opens a session on its canvas.
   *
   * A row for something off the strip is the way back, not a toggle: it clears the parent's
   * hiding and the child's, and makes sure the session is open. A row already standing toggles,
   * which is what closes an open tile from the list. The card's scroll-into-view effect fires
   * off the open set, so no scroll is aimed from here.
   */
  const onSelectChild = useCallback((parentKey: string, childKey: string) => {
    const returning = hiddenParents.has(parentKey) || offStripChildren.has(childKey);
    if (hiddenParents.has(parentKey)) {
      setHiddenParents((previous) => {
        const next = new Set(previous);
        next.delete(parentKey);
        return next;
      });
    }
    if (offStripChildren.has(childKey)) {
      setOffStripChildren((previous) => {
        const next = new Set(previous);
        next.delete(childKey);
        return next;
      });
    }
    setOpenChildren((previous) => {
      const next = new Set(previous);
      if (returning) next.add(childKey);
      else if (next.has(childKey)) next.delete(childKey);
      else next.add(childKey);
      storeOpenTerminalChildren(next);
      return next;
    });
  }, [hiddenParents, offStripChildren, setHiddenParents, setOffStripChildren, setOpenChildren]);

  const onKillChild = useCallback((key: string) => {
    const parsed = parseTerminalChildKey(key);
    if (!parsed) return Promise.reject(new Error(`not a terminal on this canvas: ${key}`));
    // The rejection travels back to the card that asked, which renders it where it was pressed.
    // Success needs nothing said: the awaited reload drops the session from the listing, the
    // prune drops its open key, and the row goes with both.
    return (async () => {
      await feedFor(parsed.machineId).killTmuxSession(parsed.session);
      await reload(all, { on: true });
      refresh();
    })();
  }, [all, feedFor, refresh, reload]);

  return {
    all,
    grouping: visibleGrouping,
    hues,
    ranks,
    loading,
    error,
    machineErrors,
    machines: all.length > 1
      ? all.map((machine) => ({ key: machineKey(machine), label: machine.label }))
      : [],
    hiddenMachines,
    onToggleMachine: (key: string) => setHiddenMachines((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    }),
    feedFor,
    hiddenParents,
    onHideParent: (key: string) => setHiddenParents((previous) => new Set(previous).add(key)),
    onShowParent: (key: string) => setHiddenParents((previous) => {
      const next = new Set(previous);
      next.delete(key);
      return next;
    }),
    offStripChildren,
    onHideChild: (key: string) => setOffStripChildren((previous) => new Set(previous).add(key)),
    onShowHiddenChildren: (parentKey: string) => setOffStripChildren((previous) => {
      // Resolved against the grouping rather than by prefix: a `machine:` prefix would also
      // match the machine's other parents, and the key being shown back is this parent's.
      const parent = [...grouping.parents, ...grouping.residue].find((each) => each.key === parentKey);
      if (!parent) return previous;
      const shown = new Set(
        parent.children.map((child) => terminalChildKey(parent.machineId, child.name)),
      );
      const next = new Set([...previous].filter((key) => !shown.has(key)));
      return next.size === previous.size ? previous : next;
    }),
    openChildren,
    onToggleChild: (key: string) => setOpenChildren((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      storeOpenTerminalChildren(next);
      return next;
    }),
    onKillChild,
    onSelectChild,
    activeOnly,
    onToggleActiveOnly: () => setActiveOnly((on) => !on),
    zoomMode,
    onToggleZoomMode: () => setZoomMode((on) => !on),
    zoomRoom,
    onZoomRoom: (size: number) => setZoomRoom(size),
    addingKeys,
    addErrors,
    onAddTerminal,
    onDismissAddError: (parentKey: string) => setAddErrors((previous) => {
      const next = new Map(previous);
      next.delete(parentKey);
      return next;
    }),
    onRefresh: refresh,
  };
}

function withoutAbsent<T>(previous: ReadonlyMap<string, T>, current: readonly BotMachine[]): ReadonlyMap<string, T> {
  const keys = new Set(current.map(machineKey));
  if ([...previous.keys()].every((key) => keys.has(key))) return previous;
  return new Map([...previous].filter(([key]) => keys.has(key)));
}
