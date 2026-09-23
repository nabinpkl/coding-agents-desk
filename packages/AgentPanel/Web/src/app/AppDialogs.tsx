// The five dialogs the shell opens over everything else.
//
// One component because they are one layer, not because they are alike: each is mounted
// unconditionally and decides for itself whether it is showing, so this is the whole of what the
// panel puts in front of the reader and there is one place to read it. Every value comes from
// above -- nothing here holds state.

import type {
  AddBotCommand,
  BotSessionRef,
  BotView,
  ProjectSummary,
  SessionSummary,
} from "@agentdesk/agent-feed-wire";
import type { BotMachine } from "@/features/bots/botMachines";
import { BotCreatorDialog } from "@/features/bots/dialogs/BotCreatorDialog";
import { SessionRenameDialog } from "@/features/bots/dialogs/SessionRenameDialog";
import { ForkSessionDialog, type ForkRequest } from "@/features/bots/dialogs/ForkSessionDialog";
import { HandoverDialog, type HandoverRequest } from "@/features/bots/dialogs/HandoverDialog";
import { BotSessionPickerDialog } from "@/features/bots/dialogs/BotSessionPickerDialog";

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
  sessionTitlesInBot,
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
  sessionTitlesInBot: string[];
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
          onClose={() => setRenamingSession(null)}
          onRename={renameSession}
        />
        <ForkSessionDialog
          request={forkRequest}
          // Every title in the source's project, so the proposal counts past the forks that are
          // already there. Read from the same list the sidebar renders, which is what the reader
          // is looking at when they press Fork.
          takenTitles={forkTitlesInProject}
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
          takenTitles={sessionTitlesInBot}
          onClose={() => setBotSessionPickerId(null)}
          onAttach={attachBotSessions}
          onStartNew={startNewSession}
        />
    </>
  );
}
