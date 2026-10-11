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

import { useCallback, useMemo, useRef } from "react";
import type { SessionSummary } from "@agentdesk/agent-feed-wire";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import { loadSelection } from "@/features/sidebar/selectionStore";
import type { BotMachine } from "@/features/bots/botMachines";
import { useMachineInventory } from "@/features/bots/useMachineInventory";
import { useProjectInventory } from "@/app/shell-state/useProjectInventory";
import type { SessionArchiving } from "@/features/sidebar/ArchivedSessions";

export function useShellInventory({
  feed,
  machineOf,
  /** The Bot whose session picker is open, if one is. Its directory is what a peer read is FOR. */
  picker,
  /** Sessions this panel started that the catalog has not heard of yet, with the Bot that owns each. */
  startedSessions,
}: {
  feed: SidecarDataSource;
  machineOf: (botId: string) => BotMachine | undefined;
  picker: { botId: string; projectPath: string } | null;
  startedSessions: readonly { botId: string; projectPath: string }[];
}) {
  // Null unless the open picker's Bot is on a machine other than the one this shell is pointed at.
  const pickerPeer = useMemo(() => {
    if (!picker) return null;
    const machine = machineOf(picker.botId);
    return machine && machine.feed !== feed ? machine : null;
  }, [picker, machineOf, feed]);
  const pickerPeerPaths = useMemo(
    () => (pickerPeer && picker ? [picker.projectPath] : []),
    [pickerPeer, picker],
  );
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
      const machine = machineOf(started.botId);
      if (!machine || machine.feed === feed) paths.push(started.projectPath);
    }
    return paths;
  }, [picker, pickerPeer, startedSessions, machineOf, feed]);

  // Read once, at mount. Storage is written on every selection, so re-reading it later would race
  // the write the shell just made.
  const rememberedSelection = useRef(loadSelection());
  const inventory = useProjectInventory(
    feed,
    extraProjectPaths,
    rememberedSelection.current?.projectPath,
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
   * The list is this machine's inventory, so this machine's feed answers for it; a Bot card or a
   * roster row archives through its own machine's feed instead.
   */
  const setSessionArchived = useCallback(
    (session: SessionSummary, archived: boolean) => feed.setSessionArchived(session, archived),
    [feed],
  );
  const archiving = useMemo<SessionArchiving>(
    () => ({ archivedByProject: inventory.archivedByProject, setArchived: setSessionArchived }),
    [inventory.archivedByProject, setSessionArchived],
  );

  return { inventory: { ...inventory, archiving }, dialogSessionsByProject, rememberedSelection };
}
