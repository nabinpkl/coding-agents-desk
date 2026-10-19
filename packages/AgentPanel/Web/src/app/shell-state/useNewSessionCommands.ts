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

import { useCallback, useMemo, useState } from "react";
import type { StartSessionCommand } from "@agentdesk/agent-feed-wire";
import type { StartedNewSession } from "@/features/session-view/StartedSessionModal";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";

export function useNewSessionCommands(feed: SidecarDataSource) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [started, setStarted] = useState<StartedNewSession | null>(null);

  /**
   * Starts it and closes the dialog, or throws for the dialog to show beside the fields it leaves
   * filled in: the first message the reader typed survives a refusal that way.
   */
  const start = useCallback(
    async (command: StartSessionCommand) => {
      const session = await feed.startSession(command);
      setStarted({ ...session, sdk: command.source === "claude" && command.claudeMode === "sdk" });
      setDialogOpen(false);
    },
    [feed],
  );

  /**
   * A chat with no project: the Chat box holds only the first message, and sending it is what
   * makes the chat's folder and starts it, through the SDK. Throws for the box to show beside the
   * message it leaves in place.
   */
  const [chatOpen, setChatOpen] = useState(false);
  const startChat = useCallback(
    async (prompt: string) => {
      const session = await feed.startScratchSession({ prompt });
      setStarted({ ...session, sdk: true });
      setChatOpen(false);
    },
    [feed],
  );
  const openChat = useCallback(() => setChatOpen(true), []);
  const closeChat = useCallback(() => setChatOpen(false), []);

  const openDialog = useCallback(() => setDialogOpen(true), []);
  const closeDialog = useCallback(() => setDialogOpen(false), []);
  const clearStarted = useCallback(() => setStarted(null), []);

  /**
   * The started session's directory, for the inventory to watch until the catalog lists it there.
   * Shaped like a Bot's started sessions, with no Bot: it is on the machine this feed reads.
   */
  const watched = useMemo(() => (started ? [{ projectPath: started.projectPath }] : []), [started]);

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
