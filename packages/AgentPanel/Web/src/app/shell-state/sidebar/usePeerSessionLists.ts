// Every other machine's Sessions list, for the Canvas tab's Sessions view.
//
// The view lists this machine's sessions from the one inventory stream the sidebar always holds
// (`useProjectInventory`). A peer's sessions come from that peer's own sidecar, the transcript
// reader for that machine, on a stream of the same shape: the projects, the sessions of the ones
// the reader unfolded, and the flat list the view merges with this machine's
// (`mergeRecentSessions`).
//
// Open only while the view is on screen. Nothing else lists a peer's sessions -- its Bots arrive on
// its Bot stream -- and a stream per peer held for the life of the panel would spend the peer's
// stream budget on a list nobody is looking at (`subscribeInventory`). Each peer retries on its
// own clock, the way `useBots` does, so one that is asleep never reopens another's stream.
//
// Asked for exactly what this machine's stream was asked for -- the same page, the same security
// reviews, the same search -- because the merge is only exact when every machine was cut at the
// same page.

import { useCallback, useMemo, useState } from "react";
import type { BotSessionRef, ProjectSummary, RecentSessionsPayload, SessionSummary } from "@agentdesk/agent-feed-wire";
import { machineFeedKey, machineKey, type BotMachine } from "@/features/bots/botMachines";
import type { SessionArchiving } from "@/features/sidebar/session-list/ArchivedSessions";
import { retryDelayMs } from "@/app/shell-state/useProjectInventory";
import { useSubscription } from "@/hooks/useSubscription";

/** One peer's Sessions list, ready to draw. */
export interface PeerSessions {
  readonly machine: BotMachine;
  readonly projects: ProjectSummary[];
  readonly sessionsByProject: ReadonlyMap<string, SessionSummary[]>;
  /** Archive and Unarchive on THIS peer, which owns the session-archive file they write. */
  readonly archiving: SessionArchiving;
  /** The flat list's page as the peer cut it, or null until it arrives or while none is wanted. */
  readonly recent: RecentSessionsPayload | null;
  readonly expandedProjectPaths: ReadonlySet<string>;
  readonly loading: boolean;
  /** Set only while nothing ever arrived: a peer that is off and a peer with no projects look alike. */
  readonly error: string | null;
  readonly retrying: boolean;
  /** The stream dropped after delivering, and what it delivered is still drawn. */
  readonly reconnecting: boolean;
}

interface PeerState {
  projects: ProjectSummary[];
  archivedProjects: ProjectSummary[];
  sessionsByProject: ReadonlyMap<string, SessionSummary[]>;
  archivedByProject: ReadonlyMap<string, SessionSummary[]>;
  recent: RecentSessionsPayload | null;
  delivered: boolean;
  error: string | null;
  retrying: boolean;
  reconnecting: boolean;
}

const EMPTY: PeerState = {
  projects: [],
  archivedProjects: [],
  sessionsByProject: new Map(),
  archivedByProject: new Map(),
  recent: null,
  delivered: false,
  error: null,
  retrying: false,
  reconnecting: false,
};
const NONE: ReadonlySet<string> = new Set();

function keepOnly<T>(byProject: ReadonlyMap<string, T>, paths: ReadonlySet<string>): ReadonlyMap<string, T> {
  if ([...byProject.keys()].every((path) => paths.has(path))) return byProject;
  return new Map([...byProject].filter(([path]) => paths.has(path)));
}

export function usePeerSessionLists({
  peers,
  showing,
  flat,
  asked,
  onListed,
}: {
  /** The machines other than the one the shell is pointed at, in the canvas's order. */
  peers: readonly BotMachine[];
  /** The Sessions view is on screen. Nothing is open while it is not. */
  showing: boolean;
  /** It is showing the flat list, so no project's own list is wanted. */
  flat: boolean;
  /** What this machine's stream was asked for (`useProjectInventory`). */
  asked: { recent: number | undefined; reviews: number; query: string };
  /** Told which sessions each peer listed, so a command addressed at one reaches that peer. */
  onListed: (machine: BotMachine, sessions: readonly BotSessionRef[]) => void;
}) {
  const [states, setStates] = useState<ReadonlyMap<string, PeerState>>(new Map());
  const [expanded, setExpanded] = useState<ReadonlyMap<string, ReadonlySet<string>>>(new Map());

  // The unfolded projects each peer's stream watches: none under the flat list, and only ones the
  // peer still has, so a folder archived while open stops being asked about.
  const watched = useMemo(() => {
    const byMachine = new Map<string, string[]>();
    for (const machine of peers) {
      const key = machineKey(machine);
      const listed = new Set((states.get(key)?.projects ?? []).map((project) => project.projectPath));
      byMachine.set(key, flat ? [] : [...(expanded.get(key) ?? NONE)].filter((path) => listed.has(path)).sort());
    }
    return byMachine;
  }, [peers, states, expanded, flat]);
  const signature = showing
    ? JSON.stringify([
        peers.map((machine) => [machineFeedKey(machine), watched.get(machineKey(machine))]),
        asked.recent ?? null,
        asked.reviews,
        asked.query,
      ])
    : null;

  useSubscription(signature, () => {
    let live = true;
    const stops = new Map<string, () => void>();
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const failures = new Map<string, number>();
    const update = (key: string, change: (current: PeerState) => PeerState) =>
      setStates((previous) => new Map(previous).set(key, change(previous.get(key) ?? EMPTY)));

    const open = (machine: BotMachine): void => {
      const key = machineKey(machine);
      const paths = watched.get(key) ?? [];
      const subscribed = new Set(paths);
      // A project no longer watched keeps no copy nothing refreshes, and a flat list no longer
      // wanted shows "Loading" when it is wanted again rather than a cut nothing has updated.
      update(key, (current) => ({
        ...current,
        sessionsByProject: keepOnly(current.sessionsByProject, subscribed),
        archivedByProject: keepOnly(current.archivedByProject, subscribed),
        recent: asked.recent === undefined ? null : current.recent,
      }));
      const stop = machine.feed.subscribeInventory(
        paths,
        {
          onProjects: (projects, archived) => {
            if (!live) return;
            failures.set(key, 0);
            update(key, (current) => ({
              ...current,
              projects,
              archivedProjects: archived,
              delivered: true,
              error: null,
              retrying: false,
              reconnecting: false,
            }));
          },
          onSessions: (projectPath, sessions, archived) => {
            if (!live) return;
            onListed(machine, [...sessions, ...archived]);
            update(key, (current) => ({
              ...current,
              sessionsByProject: new Map(current.sessionsByProject).set(projectPath, sessions),
              archivedByProject: new Map(current.archivedByProject).set(projectPath, archived),
            }));
          },
          onRecent: (recent) => {
            if (!live) return;
            onListed(machine, [...recent.recent, ...recent.securityReviews.recent]);
            update(key, (current) => ({ ...current, recent }));
          },
        },
        (reason) => {
          if (!live) return;
          update(key, (current) =>
            current.delivered
              ? { ...current, reconnecting: true, retrying: true }
              : { ...current, error: reason, retrying: true },
          );
          stops.get(key)?.();
          stops.delete(key);
          const attempt = failures.get(key) ?? 0;
          failures.set(key, attempt + 1);
          timers.set(
            key,
            setTimeout(() => {
              if (live) open(machine);
            }, retryDelayMs(attempt)),
          );
        },
        asked.recent,
        asked.reviews,
        asked.query,
      );
      stops.set(key, stop);
    };

    for (const machine of peers) open(machine);
    // A machine that went away takes its list with it.
    const present = new Set(peers.map(machineKey));
    setStates((previous) =>
      [...previous.keys()].every((key) => present.has(key))
        ? previous
        : new Map([...previous].filter(([key]) => present.has(key))),
    );
    return () => {
      live = false;
      for (const stop of stops.values()) stop();
      for (const timer of timers.values()) clearTimeout(timer);
    };
  });

  const toggleProject = useCallback(
    (key: string, projectPath: string) =>
      setExpanded((previous) => {
        const next = new Set(previous.get(key) ?? NONE);
        if (next.has(projectPath)) next.delete(projectPath);
        else next.add(projectPath);
        return new Map(previous).set(key, next);
      }),
    [setExpanded],
  );

  const lists = useMemo<PeerSessions[]>(
    () =>
      peers.map((machine) => {
        const key = machineKey(machine);
        const state = states.get(key) ?? EMPTY;
        return {
          machine,
          projects: state.projects,
          sessionsByProject: state.sessionsByProject,
          archiving: {
            archivedByProject: state.archivedByProject,
            setArchived: (session, archived) => machine.feed.setSessionArchived(session, archived),
            projects: {
              archived: state.archivedProjects,
              setArchived: (projectPath, archived) => machine.feed.setProjectArchived(projectPath, archived),
              archiveSessions: (projectPath) => machine.feed.archiveProjectSessions(projectPath),
            },
          },
          recent: state.recent,
          expandedProjectPaths: expanded.get(key) ?? NONE,
          loading: !state.delivered && state.error === null,
          error: state.delivered ? null : state.error,
          retrying: state.retrying,
          reconnecting: state.reconnecting,
        };
      }),
    [peers, states, expanded],
  );

  return { lists, toggleProject };
}
