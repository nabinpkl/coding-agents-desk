// The four dialogs the shell opens over everything else.
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
import { BotCreatorDialog } from "@/features/bots/BotCreatorDialog";
import { SessionRenameDialog } from "@/features/bots/SessionRenameDialog";
import { ForkSessionDialog } from "@/features/bots/ForkSessionDialog";
import { BotSessionPickerDialog } from "@/features/bots/BotSessionPickerDialog";

export function AppDialogs({
  attachBotSessions,
  botCreatorOpen,
  bots,
  botSessionPicker,
  createBot,
  forkRequest,
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
  setRenamingSession,
  startFork,
  startNewSession,
}: {
  attachBotSessions: (bot: BotView, sessionRefs: BotSessionRef[]) => Promise<void>;
  botCreatorOpen: boolean;
  bots: BotView[];
  botSessionPicker: BotView | null;
  createBot: (command: Omit<AddBotCommand, "requestId">) => Promise<void>;
  forkRequest: { session: SessionSummary; botId: string; projectPath: string } | null;
  forkTitlesInProject: string[];
  inventoryLoading: boolean;
  projects: ProjectSummary[];
  renameSession: (session: SessionSummary, title: string) => Promise<void>;
  renamingSession: SessionSummary | null;
  sessionsByProject: Map<string, SessionSummary[]>;
  sessionTitlesInBot: string[];
  setBotCreatorOpen: (open: boolean) => void;
  setBotSessionPickerId: (botId: string | null) => void;
  setForkRequest: (
    request: { session: SessionSummary; botId: string; projectPath: string } | null,
  ) => void;
  setRenamingSession: (session: SessionSummary | null) => void;
  startFork: (
    request: { session: SessionSummary; botId: string; projectPath: string },
    forkTitle: string,
    brief: string,
    worktree: boolean,
  ) => Promise<void>;
  startNewSession: (bot: BotView, title: string) => Promise<void>;
}) {
  return (
    <>
        <BotCreatorDialog
          open={botCreatorOpen}
          projects={projects}
          bots={bots}
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
