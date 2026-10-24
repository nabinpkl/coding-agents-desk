// Starting a session on no Bot, from the Canvas tab's Sessions view.
//
// Two pieces of state, because a start has two moments the reader sees. The dialog asks where, in
// which harness and under what name. Then the session is running and, for Claude, not yet a
// session anywhere the panel reads from: the CLI writes no transcript until its first turn, so the
// only thing to show is its pane -- or, for one run through the Agent SDK, its session view with an
// empty feed, since that pane holds the runner's log and the runner takes the first message.
// `started` holds that until the catalog lists the session, at which point the modal over the
// canvas takes it as an ordinary session.
//
// A chat skips the dialog: the Chat box asks only for the first message, and the sidecar picks
// everything else. Once sent it is `started` like any other, so it hands over the same way.
//
// The dialog can start one on another machine than the one the panel points at. Then `started`
// names that machine, and everything that follows it -- the terminal, the read that waits for the
// catalog, the modal it is handed to -- goes there.

import { useCallback, useMemo, useState } from "react";
import type { BotSessionRef, StartSessionCommand } from "@agentdesk/agent-feed-wire";
import type { StartedNewSession } from "@/features/session-view/modal/StartedSessionModal";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import { machineKey, type BotMachine } from "@/features/bots/botMachines";

/** A started session, and the machine it was started on when that is not the panel's own (`machineKey`). */
type StartedOn = StartedNewSession & { machine?: string };

export function useNewSessionCommands(
  feed: SidecarDataSource,
  /** Records a session started on another machine as that machine's, so its commands go there. */
  noteListed: (machine: BotMachine, sessions: readonly BotSessionRef[]) => void,
) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [started, setStarted] = useState<StartedOn | null>(null);

  /**
   * Starts it and closes the dialog, or throws for the dialog to show beside the fields it leaves
   * filled in: the first message the reader typed survives a refusal that way.
   */
  const start = useCallback(
    async (command: StartSessionCommand, machine?: BotMachine) => {
      const elsewhere = machine && machine.feed !== feed ? machine : undefined;
      const session = await (elsewhere?.feed ?? feed).startSession(command);
      // Before anything can address it: rename and fork from its modal find their machine this way.
      if (elsewhere) noteListed(elsewhere, [session]);
      setStarted({
        ...session,
        sdk: command.source === "claude" && command.claudeMode === "sdk",
        ...(elsewhere ? { machine: machineKey(elsewhere) } : {}),
      });
      setDialogOpen(false);
    },
    [feed, noteListed],
  );

  /**
   * A chat with no project: the Chat box holds only the first message, and sending it is what
   * makes the chat's folder and starts it, through the SDK, on the machine the box picked. Throws
   * for the box to show beside the message it leaves in place.
   */
  const [chatOpen, setChatOpen] = useState(false);
  const startChat = useCallback(
    async (prompt: string, machine?: BotMachine) => {
      const elsewhere = machine && machine.feed !== feed ? machine : undefined;
      const session = await (elsewhere?.feed ?? feed).startScratchSession({ prompt });
      if (elsewhere) noteListed(elsewhere, [session]);
      setStarted({ ...session, sdk: true, ...(elsewhere ? { machine: machineKey(elsewhere) } : {}) });
      setChatOpen(false);
    },
    [feed, noteListed],
  );
  const openChat = useCallback(() => setChatOpen(true), []);
  const closeChat = useCallback(() => setChatOpen(false), []);

  const openDialog = useCallback(() => setDialogOpen(true), []);
  const closeDialog = useCallback(() => setDialogOpen(false), []);
  const clearStarted = useCallback(() => setStarted(null), []);

  /**
   * The started session's directory, for the inventory to watch until the catalog lists it there.
   * Shaped like a Bot's started sessions, with no Bot, and with the machine it is on when that is
   * not the one this feed reads.
   */
  const watched = useMemo(
    () =>
      started
        ? [
            {
              projectPath: started.projectPath,
              ...(started.machine === undefined ? {} : { machine: started.machine }),
            },
          ]
        : [],
    [started],
  );

  return {
    dialogOpen,
    openDialog,
    closeDialog,
    start,
    chatOpen,
    openChat,
    closeChat,
    startChat,
    started,
    clearStarted,
    watched,
  };
}
