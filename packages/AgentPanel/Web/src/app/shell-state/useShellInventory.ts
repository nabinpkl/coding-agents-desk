// Which directories the shell watches, and which of them are not on this machine.
//
// One stream for the sidebar, always open, because the sidebar is always showing
// (`useProjectInventory`). Plus, and only while a dialog is asking, one scoped read of a PEER's
// directory (`useMachineInventory`) -- because a Bot's directory can be on another machine now, and
// a directory is a question only its own machine can answer.
//
// Together here rather than apart because the two are one answer with a seam in it: every consumer
// wants "the sessions in this directory" and none of them wants to know which sidecar was asked.
// Before this, the peer half did not exist and the seam was invisible: a peer Bot's session picker
// sat on "Loading sessions from this directory" for good, because the Mac's inventory stream
// accepted the path, found no project, and never sent a sessions message for it.

import { useCallback, useMemo, useState } from "react";
import type { SessionSummary } from "@agentdesk/agent-feed-wire";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import { loadSelection } from "@/features/sidebar/selectionStore";
import type { BotMachine } from "@/features/bots/botMachines";
import { useMachineInventory } from "@/features/bots/useMachineInventory";
import { useProjectInventory } from "@/app/shell-state/useProjectInventory";
import { usePeerSessionLists } from "@/app/shell-state/sidebar/usePeerSessionLists";
import type { ShellMachines } from "@/app/shell-state/useBotMachines";
import type { SessionArchiving } from "@/features/sidebar/session-list/ArchivedSessions";

export function useShellInventory({
  feed,
  /** Every machine, for the Sessions view's other machines, and where their rows are recorded. */
  machines,
  /** Which machine each Bot is on, as of this render: the reads below are decided while rendering. */
  botMachines,
  /** The Bot whose session picker is open, if one is. Its directory is what a peer read is FOR. */
  picker,
  /**
   * Sessions this panel started that the catalog has not heard of yet, with the Bot that owns each.
   * One with no Bot was started from the Sessions view, on the machine this shell reads.
   */
  startedSessions,
  /** Whether the flat, most-recently-changed sessions list is on screen. See `useProjectInventory`. */
  recentWanted,
  /** Whether the Sessions view a title search is typed in is on screen. See `useProjectInventory`. */
  searchable,
}: {
  feed: SidecarDataSource;
  machines: Pick<ShellMachines, "all" | "noteListed">;
  botMachines: ReadonlyMap<string, BotMachine>;
  picker: { botId: string; projectPath: string } | null;
  startedSessions: readonly { botId?: string; projectPath: string }[];
  recentWanted: boolean;
  searchable: boolean;
}) {
  // Null unless the open picker's Bot is on a machine other than the one this shell is pointed at.
  const pickerPeer = useMemo(() => {
    if (!picker) return null;
    const machine = botMachines.get(picker.botId);
    return machine && machine.feed !== feed ? machine : null;
  }, [picker, botMachines, feed]);
  const pickerPeerPaths = useMemo(() => (pickerPeer && picker ? [picker.projectPath] : []), [pickerPeer, picker]);
  const peerInventory = useMachineInventory(pickerPeer, pickerPeerPaths);

  /** The directories this machine's stream must watch beyond the ones the reader expanded. */
  const extraProjectPaths = useMemo(() => {
    const paths: string[] = [];
    // Only when the Bot is on THIS machine. A peer's directory on this machine's stream is a path
    // the sidecar logs as an unknown project and answers nothing about, so asking costs a stream
    // reopen and buys a log line.
    if (picker && !pickerPeer) paths.push(picker.projectPath);
    // A started session's own directory, which is not always its Bot's: a session in a worktree is
    // listed under the worktree. Subscribed so the canvas sees it become a real session and stops
    // rendering the placeholder card, not so it can be attached -- the Bot did that when it started
    // it. A session started on a peer is watched by that peer's own Bot stream instead.
    for (const started of startedSessions) {
      const machine = started.botId === undefined ? undefined : botMachines.get(started.botId);
      if (!machine || machine.feed === feed) paths.push(started.projectPath);
    }
    return paths;
  }, [picker, pickerPeer, startedSessions, botMachines, feed]);

  // Read once, at mount. Storage is written on every selection, so re-reading it later would race
  // the write the shell just made.
  const [rememberedSelection] = useState(loadSelection);
  const inventory = useProjectInventory(
    feed,
    extraProjectPaths,
    rememberedSelection?.projectPath,
    recentWanted,
    searchable,
  );

  /**
   * The sessions each directory holds, as the DIALOGS see it.
   *
   * This machine's inventory with the open picker's peer directory laid over it. An overlay rather
   * than a swap because the fork dialog reads the same map for a directory on this machine, and
   * only one dialog is open at a time; the peer wins its own path for exactly as long as its picker
   * is asking about it, which is the only window in which both could name it.
   *
   * The sidebar and the thread deliberately keep reading `inventory.sessionsByProject` instead:
   * those are this machine's rows, and a peer's directory is not something either can select into.
   */
  const dialogSessionsByProject = useMemo<ReadonlyMap<string, SessionSummary[]>>(() => {
    if (!pickerPeer) return inventory.sessionsByProject;
    const merged = new Map(inventory.sessionsByProject);
    for (const [path, sessions] of peerInventory.sessionsByProject) merged.set(path, sessions);
    return merged;
  }, [inventory.sessionsByProject, pickerPeer, peerInventory.sessionsByProject]);

  /**
   * Archiving from the project list, on the machine the list is reading.
   *
   * This machine's list, so this machine's feed answers for it. Another machine's list in the
   * Sessions view archives through that machine's feed (`usePeerSessionLists`), and a Bot card or a
   * roster row through its own Bot's.
   */
  const setSessionArchived = useCallback(
    (session: SessionSummary, archived: boolean) => feed.setSessionArchived(session, archived),
    [feed],
  );
  const setProjectArchived = useCallback(
    (projectPath: string, archived: boolean) => feed.setProjectArchived(projectPath, archived),
    [feed],
  );
  const archiveProjectSessions = useCallback((projectPath: string) => feed.archiveProjectSessions(projectPath), [feed]);
  const archiving = useMemo<SessionArchiving>(
    () => ({
      archivedByProject: inventory.archivedByProject,
      setArchived: setSessionArchived,
      projects: {
        archived: inventory.archivedProjects,
        setArchived: setProjectArchived,
        archiveSessions: archiveProjectSessions,
      },
    }),
    [
      inventory.archivedByProject,
      inventory.archivedProjects,
      setSessionArchived,
      setProjectArchived,
      archiveProjectSessions,
    ],
  );

  // The Sessions view lists every machine, so it reads the others while it is on screen. Asked what
  // this machine's stream was asked, so the flat lists merge exactly (`mergeRecentSessions`).
  const peerMachines = useMemo(() => machines.all.filter((machine) => machine.feed !== feed), [machines.all, feed]);
  const peers = usePeerSessionLists({
    peers: peerMachines,
    showing: searchable,
    flat: recentWanted,
    asked: inventory.asked,
    onListed: machines.noteListed,
  });

  return {
    inventory: { ...inventory, archiving, peers: peers.lists, togglePeerProject: peers.toggleProject },
    dialogSessionsByProject,
    rememberedSelection,
  };
}
