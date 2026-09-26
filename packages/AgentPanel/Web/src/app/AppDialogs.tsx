// The five dialogs the shell opens over everything else.
//
// One component because they are one layer, not because they are alike: each is mounted
// unconditionally and decides for itself whether it is showing, so this is the whole of what the
// panel puts in front of the reader and there is one place to read it. Every value comes from
// above -- nothing here holds state.

import {
  stableSessionAnchor,
  type AddBotCommand,
  type BotSessionRef,
  type BotView,
  type ProjectSummary,
  type SessionSummary,
} from "@agentdesk/agent-feed-wire";
import { useMemo } from "react";
import type { BotMachine } from "@/features/bots/botMachines";
import { BotCreatorDialog } from "@/features/bots/dialogs/BotCreatorDialog";
import { SessionRenameDialog } from "@/features/bots/dialogs/SessionRenameDialog";
import { ForkSessionDialog, type ForkRequest } from "@/features/bots/dialogs/ForkSessionDialog";
import { HandoverDialog, type HandoverRequest } from "@/features/bots/dialogs/HandoverDialog";
import { BotSessionPickerDialog } from "@/features/bots/dialogs/BotSessionPickerDialog";
import { botSessionSlots } from "@/features/bots/botSurface";

export function AppDialogs({
  attachBotSessions,
  botCreatorOpen,
  bots,
  botSessionPicker,
  createBot,
  forkRequest,
  handoverRequest,
  machines,
  machineOfBot,
  forkTitlesInProject,
  inventoryLoading,
  projects,
  renameSession,
  renamingSession,
  sessionsByProject,
  setBotCreatorOpen,
  setBotSessionPickerId,
  setForkRequest,
  setHandoverRequest,
  setRenamingSession,
  startFork,
  startHandover,
  startNewSession,
}: {
  attachBotSessions: (bot: BotView, sessionRefs: BotSessionRef[]) => Promise<void>;
  botCreatorOpen: boolean;
  bots: BotView[];
  botSessionPicker: BotView | null;
  createBot: (command: Omit<AddBotCommand, "requestId">, machine: BotMachine) => Promise<void>;
  forkRequest: ForkRequest | null;
  handoverRequest: HandoverRequest | null;
  forkTitlesInProject: string[];
  /** Every sidecar a Bot can be created on. See `botMachines.ts` for why the record stays there. */
  machines: readonly BotMachine[];
  machineOfBot: (botId: string) => BotMachine | undefined;
  inventoryLoading: boolean;
  projects: ProjectSummary[];
  renameSession: (session: SessionSummary, title: string) => Promise<void>;
  renamingSession: SessionSummary | null;
  /** Read-only: the shell owns this map, and one of its entries can come from another machine. */
  sessionsByProject: ReadonlyMap<string, SessionSummary[]>;
  setBotCreatorOpen: (open: boolean) => void;
  setBotSessionPickerId: (botId: string | null) => void;
  setForkRequest: (request: ForkRequest | null) => void;
  setHandoverRequest: (request: HandoverRequest | null) => void;
  setRenamingSession: (session: SessionSummary | null) => void;
  startFork: (
    request: ForkRequest,
    forkTitle: string,
    brief: string,
    worktree: boolean,
  ) => Promise<void>;
  startHandover: (request: HandoverRequest, message: string) => Promise<void>;
  startNewSession: (bot: BotView, title: string) => Promise<void>;
}) {
  const slotOf = (bot: BotView, session: Pick<SessionSummary, "source" | "sessionId">): number | undefined =>
    botSessionSlots(bot.sessionRefs, bot.sessionSlots).get(`${session.source}:${session.sessionId}`);
  // The anchor a fork onto a Bot starts under: the Bot's next slot, spent from its counter rather
  // than counted from titles.
  const forkBotAnchor = useMemo(() => {
    if (!forkRequest?.botId) return undefined;
    const bot = bots.find((one) => one.botId === forkRequest.botId);
    return bot ? stableSessionAnchor(bot.name, bot.nextSessionSlot ?? bot.sessionRefs.length) : undefined;
  }, [bots, forkRequest]);
  // The anchor a rename must leave alone, when exactly one Bot holds the session. Held twice over,
  // two anchors name it and the dialog edits the whole title the way it always has.
  const renameAnchor = useMemo(() => {
    if (!renamingSession) return undefined;
    const holders = bots.filter((bot) => slotOf(bot, renamingSession) !== undefined);
    if (holders.length !== 1) return undefined;
    return stableSessionAnchor(holders[0]!.name, slotOf(holders[0]!, renamingSession)!);
  }, [bots, renamingSession]);
  return (
    <>
        <BotCreatorDialog
          open={botCreatorOpen}
          projects={projects}
          bots={bots}
          machines={machines}
          machineOfBot={machineOfBot}
          inventoryLoading={inventoryLoading}
          onClose={() => setBotCreatorOpen(false)}
          onCreate={createBot}
        />
        <SessionRenameDialog
          session={renamingSession}
          anchor={renameAnchor}
          onClose={() => setRenamingSession(null)}
          onRename={renameSession}
        />
        <ForkSessionDialog
          request={forkRequest}
          // Every title in the source's project, so the proposal counts past the forks that are
          // already there. Read from the same list the sidebar renders, which is what the reader
          // is looking at when they press Fork.
          takenTitles={forkTitlesInProject}
          botAnchor={forkBotAnchor}
          onClose={() => setForkRequest(null)}
          onFork={startFork}
        />
        <HandoverDialog
          request={handoverRequest}
          onClose={() => setHandoverRequest(null)}
          onHandover={startHandover}
        />
        <BotSessionPickerDialog
          open={botSessionPicker !== null}
          bot={botSessionPicker}
          sessions={botSessionPicker ? sessionsByProject.get(botSessionPicker.environment.path) : undefined}
          onClose={() => setBotSessionPickerId(null)}
          onAttach={attachBotSessions}
          onStartNew={startNewSession}
        />
    </>
  );
}
