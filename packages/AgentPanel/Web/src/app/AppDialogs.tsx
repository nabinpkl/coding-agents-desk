// The dialogs the shell opens over everything else, and the session modal beside them.
//
// One component because they are one layer, not because they are alike: each is mounted
// unconditionally and decides for itself whether it is showing, so this is the whole of what the
// panel puts in front of the reader and there is one place to read it. Every value comes from
// above -- nothing here holds state.

import { PanelErrorBoundary } from "@/app/PanelErrorBoundary";
import {
  type AddBotCommand,
  type BotSessionRef,
  type BotView,
  type ProjectSummary,
  type SessionSummary,
} from "@agentdesk/agent-feed-wire";
import { useMemo } from "react";
import type { BotMachine } from "@/features/bots/botMachines";
import { BotCreatorDialog } from "@/features/bots/dialogs/BotCreatorDialog";
import { BotRenameDialog } from "@/features/bots/dialogs/BotRenameDialog";
import { SessionRenameDialog } from "@/features/bots/dialogs/SessionRenameDialog";
import type { NewSessionHarness } from "@/features/bots/dialogs/BotSessionPickerDialog";
import { ForkSessionDialog, type ForkRequest } from "@/features/bots/dialogs/ForkSessionDialog";
import { HandoverDialog, type HandoverRequest } from "@/features/bots/dialogs/HandoverDialog";
import { BotSessionPickerDialog } from "@/features/bots/dialogs/BotSessionPickerDialog";
import { NewSessionDialog } from "@/features/bots/dialogs/NewSessionDialog";
import { ChatDraftDialog } from "@/features/bots/dialogs/ChatDraftDialog";
import { SessionModal } from "@/features/session-view/SessionModal";
import { StartedSessionModal } from "@/features/session-view/StartedSessionModal";
import type { useNewSessionCommands } from "@/app/shell-state/useNewSessionCommands";
import type { SessionViewContext } from "@/features/session-view/sessionTerminalTypes";
import { sessionKey } from "@/features/bots/cards/botCanvasCards";
import { botSessionMarkNow, type SessionFaces } from "@/features/bots/avatar/botSessionFaces";

export function AppDialogs({
  attachBotSessions,
  botCreatorOpen,
  bots,
  botSessionPicker,
  createBot,
  forkRequest,
  handoverRequest,
  machines,
  botMachines,
  forkTitlesInProject,
  inventoryLoading,
  projects,
  renameBot,
  renameSession,
  renamingBot,
  renamingSession,
  sessionsByProject,
  setBotCreatorOpen,
  setBotSessionPickerId,
  setForkRequest,
  setHandoverRequest,
  setRenamingBot,
  setRenamingSession,
  startFork,
  startHandover,
  startNewSession,
  newSession,
  sessionModal,
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
  botMachines: ReadonlyMap<string, BotMachine>;
  inventoryLoading: boolean;
  projects: ProjectSummary[];
  renameBot: (bot: BotView, restyle: { name: string; iconUrl?: string; role?: string }) => Promise<void>;
  renameSession: (session: SessionSummary, title: string) => Promise<void>;
  renamingBot: BotView | null;
  renamingSession: SessionSummary | null;
  /** Read-only: the shell owns this map, and one of its entries can come from another machine. */
  sessionsByProject: ReadonlyMap<string, SessionSummary[]>;
  setBotCreatorOpen: (open: boolean) => void;
  setBotSessionPickerId: (botId: string | null) => void;
  setForkRequest: (request: ForkRequest | null) => void;
  setHandoverRequest: (request: HandoverRequest | null) => void;
  setRenamingBot: (bot: BotView | null) => void;
  setRenamingSession: (session: SessionSummary | null) => void;
  startFork: (request: ForkRequest, forkTitle: string, brief: string, worktree: boolean) => Promise<void>;
  startHandover: (request: HandoverRequest, message: string) => Promise<void>;
  startNewSession: (bot: BotView, title: string, harness: NewSessionHarness) => Promise<void>;
  /**
   * A session on no Bot, from the Sessions view: its dialog, and the session it started until the
   * catalog lists it, when `onListed` opens it in the session modal instead.
   */
  newSession: ReturnType<typeof useNewSessionCommands> & {
    onListed: (project: ProjectSummary, session: SessionSummary) => void;
  };
  /**
   * The session opened in the modal, or null; mounted only while it is open. From the Canvas tab's
   * Sessions view, or maximized from a Bot's card, which names its Bot.
   */
  sessionModal: {
    thread: { project: ProjectSummary; session: SessionSummary; botId?: string; machine?: string } | null;
    context: SessionViewContext;
    /** A Bot's session reads from that Bot's machine, the way its card does. */
    contextFor: (botId: string) => SessionViewContext;
    /** And one picked from another machine's Sessions list reads from that machine, by its key. */
    contextOn: (key: string) => SessionViewContext;
    onClose: () => void;
    /** Moves the session onto its directory's Bot. Not offered on a session a Bot already holds. */
    canvasMove: { held: ReadonlySet<string>; onMove: (session: SessionSummary) => Promise<void> };
    /** The face each Bot's session wears, the same map the Canvas Sessions view draws from. */
    faces: SessionFaces;
  };
}) {
  // The anchor a rename must leave alone, when exactly one Bot holds the session with one stored.
  // Held twice over, or held with none yet, and the dialog edits the whole title the way it
  // always has.
  const renameAnchor = useMemo(() => {
    if (!renamingSession) return undefined;
    const holders = bots.filter((bot) => bot.sessionAnchors?.[sessionKey(renamingSession)] !== undefined);
    if (holders.length !== 1) return undefined;
    return holders[0]!.sessionAnchors![sessionKey(renamingSession)]!;
  }, [bots, renamingSession]);
  // A Bot's session wears its face in the modal's header, ringed by its activity as the roster has
  // it now rather than as it was when the modal opened.
  const modalMark = sessionModal.thread
    ? botSessionMarkNow(sessionModal.faces, bots, sessionKey(sessionModal.thread.session))
    : undefined;
  // What the modal's code button opens: the Bot it was maximized from, or else the first Bot that
  // holds the session, with that Bot's own record of it, which alone carries its worktree.
  const modalCode = (() => {
    const thread = sessionModal.thread;
    if (!thread) return undefined;
    const key = sessionKey(thread.session);
    const holds = (bot: BotView) => bot.sessions.some((each) => sessionKey(each) === key);
    const bot = bots.find((each) => each.botId === thread.botId && holds(each)) ?? bots.find(holds);
    const session = bot?.sessions.find((each) => sessionKey(each) === key);
    return bot && session ? { bot, session, feed: sessionModal.contextFor(bot.botId).feed } : undefined;
  })();
  // The machine the Sessions view reads, which is the shell's: a new session starts where it will
  // be listed.
  const shellFeed = sessionModal.context.feed;
  const shellMachine = useMemo(
    () => machines.find((machine) => machine.feed === shellFeed) ?? { label: "This machine", feed: shellFeed },
    [machines, shellFeed],
  );
  // The picker's preview, same rule as the fork's.
  const pickerAnchor = botSessionPicker?.nextAnchor ?? "";
  // Each dialog behind its own boundary: they mount here, beside the canvas rather than inside any
  // card, so one that threw used to cost the whole Feed tab.
  return (
    <>
      <PanelErrorBoundary surface="new Bot dialog" overlay onDismiss={() => setBotCreatorOpen(false)}>
        <BotCreatorDialog
          open={botCreatorOpen}
          projects={projects}
          bots={bots}
          machines={machines}
          botMachines={botMachines}
          inventoryLoading={inventoryLoading}
          onClose={() => setBotCreatorOpen(false)}
          onCreate={createBot}
        />
      </PanelErrorBoundary>
      <PanelErrorBoundary surface="rename dialog" overlay onDismiss={() => setRenamingSession(null)}>
        <SessionRenameDialog
          session={renamingSession}
          anchor={renameAnchor}
          onClose={() => setRenamingSession(null)}
          onRename={renameSession}
        />
      </PanelErrorBoundary>
      <PanelErrorBoundary surface="Bot rename dialog" overlay onDismiss={() => setRenamingBot(null)}>
        <BotRenameDialog bot={renamingBot} onClose={() => setRenamingBot(null)} onRename={renameBot} />
      </PanelErrorBoundary>
      <PanelErrorBoundary surface="fork dialog" overlay onDismiss={() => setForkRequest(null)}>
        <ForkSessionDialog
          request={forkRequest}
          // Every title in the source's project, so the proposal counts past the forks that are
          // already there. Read from the same list the sidebar renders, which is what the reader
          // is looking at when they press Fork.
          takenTitles={forkTitlesInProject}
          onClose={() => setForkRequest(null)}
          onFork={startFork}
        />
      </PanelErrorBoundary>
      <PanelErrorBoundary surface="handover dialog" overlay onDismiss={() => setHandoverRequest(null)}>
        <HandoverDialog request={handoverRequest} onClose={() => setHandoverRequest(null)} onHandover={startHandover} />
      </PanelErrorBoundary>
      <PanelErrorBoundary surface="session picker" overlay onDismiss={() => setBotSessionPickerId(null)}>
        <BotSessionPickerDialog
          open={botSessionPicker !== null}
          bot={botSessionPicker}
          sessions={botSessionPicker ? sessionsByProject.get(botSessionPicker.environment.path) : undefined}
          anchorPreview={pickerAnchor}
          onClose={() => setBotSessionPickerId(null)}
          onAttach={attachBotSessions}
          onStartNew={startNewSession}
        />
      </PanelErrorBoundary>
      <PanelErrorBoundary surface="new session dialog" overlay onDismiss={newSession.closeDialog}>
        <NewSessionDialog
          open={newSession.dialogOpen}
          machine={shellMachine}
          projects={projects}
          loading={inventoryLoading}
          onClose={newSession.closeDialog}
          onStart={newSession.start}
        />
      </PanelErrorBoundary>
      {newSession.chatOpen ? (
        <PanelErrorBoundary surface="new chat" overlay onDismiss={newSession.closeChat}>
          <ChatDraftDialog onClose={newSession.closeChat} onStart={newSession.startChat} />
        </PanelErrorBoundary>
      ) : null}
      {newSession.started ? (
        <PanelErrorBoundary
          key={sessionKey(newSession.started)}
          surface="started session"
          overlay
          onDismiss={newSession.clearStarted}
        >
          <StartedSessionModal
            feed={shellFeed}
            context={sessionModal.context}
            started={newSession.started}
            projects={projects}
            sessionsByProject={sessionsByProject}
            onListed={(project, session) => {
              newSession.clearStarted();
              newSession.onListed(project, session);
            }}
            onClose={newSession.clearStarted}
          />
        </PanelErrorBoundary>
      ) : null}
      {sessionModal.thread ? (
        <PanelErrorBoundary
          key={sessionKey(sessionModal.thread.session)}
          surface="session window"
          overlay
          onDismiss={sessionModal.onClose}
        >
          <SessionModal
            context={
              sessionModal.thread.botId !== undefined
                ? sessionModal.contextFor(sessionModal.thread.botId)
                : sessionModal.thread.machine !== undefined
                  ? sessionModal.contextOn(sessionModal.thread.machine)
                  : sessionModal.context
            }
            {...(sessionModal.thread.botId === undefined ? {} : { botId: sessionModal.thread.botId })}
            project={sessionModal.thread.project}
            session={sessionModal.thread.session}
            onClose={sessionModal.onClose}
            {...(modalMark ? { mark: modalMark } : {})}
            {...(modalCode ? { code: modalCode } : {})}
            {...(sessionModal.canvasMove.held.has(sessionKey(sessionModal.thread.session))
              ? {}
              : { onMoveToCanvas: sessionModal.canvasMove.onMove })}
          />
        </PanelErrorBoundary>
      ) : null}
    </>
  );
}
