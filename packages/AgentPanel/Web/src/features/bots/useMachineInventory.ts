// What one machine has, for as long as something is asking.
//
// The app already holds THIS machine's inventory: `useProjectInventory` keeps one stream open for
// the whole sidebar, because the sidebar is always showing. A peer's directories are not like that.
// Nothing on the canvas lists them -- a Bot card shows its own path and its own sessions, both of
// which arrive on that machine's Bot stream -- so the only moments a peer's inventory is wanted are
// the two dialogs that ask a directory a question: "which folders are on this machine" when adding
// a Bot, and "which sessions are in this folder" when attaching one.
//
// So this is deliberately NOT a second app-scoped inventory. It subscribes when asked and drops
// when the asking stops. Holding a stream per declared peer for the life of the panel would spend
// the sidecar's finite stream budget (see `subscribeInventory` for what ran out of it first) on a
// list nobody is looking at.

import { useEffect, useMemo, useState } from "react";
import type { ProjectSummary, SessionSummary } from "@agentdesk/agent-feed-wire";
import { machineFeedKey, type BotMachine } from "@/features/bots/botMachines";

export interface MachineInventory {
  projects: ProjectSummary[];
  /** The sessions in each of the requested directories, by path. */
  sessionsByProject: ReadonlyMap<string, SessionSummary[]>;
  loading: boolean;
  /** Named, never swallowed: an unreachable peer and a peer with no projects look identical. */
  error: string | null;
}

const NOTHING: MachineInventory = {
  projects: [],
  sessionsByProject: new Map(),
  loading: false,
  error: null,
};

/**
 * One machine's projects, and the sessions inside the directories named.
 *
 * Null machine means "not now" -- a closed dialog, or one sitting on the machine whose inventory
 * the app already has. Nothing subscribes and nothing is returned.
 *
 * No retry. This lives as long as a dialog does, and a reader looking at an empty list with a
 * reason on it can close and reopen; a backoff loop behind a dialog would outlive the dialog's
 * usefulness and keep asking a peer that is off.
 */
export function useMachineInventory(
  machine: BotMachine | null,
  projectPaths: readonly string[],
): MachineInventory {
  const [state, setState] = useState<MachineInventory>(NOTHING);
  // The subscription's identity rather than its argument, the same rule `useProjectInventory`
  // follows and for the same reason: the sidecar reads the set when the stream opens, so a
  // re-render that rebuilt the array must not reopen it. NUL is the one byte a POSIX path cannot
  // contain, so the round trip can neither invent nor lose a path.
  const pathKey = useMemo(() => [...new Set(projectPaths)].sort().join("\0"), [projectPaths]);
  const key = machine === null ? null : `${machineFeedKey(machine)}${pathKey}`;

  useEffect(() => {
    if (machine === null) {
      setState(NOTHING);
      return;
    }
    let live = true;
    const paths = pathKey === "" ? [] : pathKey.split("\0");
    setState({ projects: [], sessionsByProject: new Map(), loading: true, error: null });
    const stop = machine.feed.subscribeInventory(
      paths,
      {
        onProjects: (projects) => {
          if (live) setState((previous) => ({ ...previous, projects, loading: false, error: null }));
        },
        onSessions: (projectPath, sessions) => {
          if (!live) return;
          setState((previous) => ({
            ...previous,
            sessionsByProject: new Map(previous.sessionsByProject).set(projectPath, sessions),
            loading: false,
            error: null,
          }));
        },
      },
      (reason) => {
        if (live) setState({ ...NOTHING, error: reason });
      },
    );
    return () => {
      live = false;
      stop();
    };
    // Keyed on the machine, its data source and the paths rather than on the objects: a re-render
    // that rebuilt either must not tear down and reopen the stream underneath an open dialog, and a
    // data source swapped in by a save must not leave the stream on the one it replaced.
  }, [key]);

  return state;
}
