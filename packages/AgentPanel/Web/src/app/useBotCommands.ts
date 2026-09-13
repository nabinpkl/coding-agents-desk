// Everything the shell asks a Bot to do, and the failures it reports back.
//
// Creating a Bot, attaching sessions to one, forking a session, starting a fresh one, renaming
// one, dropping one: all of them are a call to the sidecar and then nothing, because the Bot
// stream publishes a new snapshot and the rows move on their own. What is here is what that
// leaves behind -- the dialogs that are open, the sessions the catalog has not heard of yet, and
// where a failure is said.
//
// It writes into the canvas roster in three places, which is why those setters are passed in: a
// started session opens its card, a fork puts its Bot back, and a detach forgets the key that
// hid the row.

import { useCallback, useState } from "react";
import type {
  AddBotCommand,
  BotSessionRef,
  BotView,
  SessionSummary,
} from "@agentdesk/agent-feed-wire";
import type { SidecarDataSource } from "../features/activity-feed/data-source/SidecarDataSource";
import type { BotCommandError } from "../features/bots/BotCanvas";
import type { NewBotSession } from "../features/bots/BotNewSessionCard";

export function useBotCommands(
  feed: SidecarDataSource,
  roster: {
    setDetachedBotIds: React.Dispatch<React.SetStateAction<ReadonlySet<string>>>;
    setDetachedSessionKeys: React.Dispatch<React.SetStateAction<ReadonlySet<string>>>;
    setCanvasOpenKeys: React.Dispatch<React.SetStateAction<ReadonlySet<string>>>;
  },
  /** Dropped whenever a picker or dialog opens, so a peek never stacks over the thing it opened. */
  setHoverPreviewOpen: (open: boolean) => void,
) {
  const { setCanvasOpenKeys, setDetachedBotIds, setDetachedSessionKeys } = roster;
  // A failure from a command the shell issues rather than the thread -- today, editing a Bot.
  // Carries the session it is about, because the canvas shows several at once and a bare string was
  // painted on every one of them; see `BotCommandError`.
  const [botCommandError, setBotCommandError] = useState<BotCommandError | null>(null);
  const [botCreatorOpen, setBotCreatorOpen] = useState(false);
  const [botSessionPickerId, setBotSessionPickerId] = useState<string | null>(null);
  /**
   * A session forked from another, and the pane it runs in.
   *
   * Held here rather than in the canvas because it takes over `main`, and because the fork's own
   * identity has to outlive the row that started it: the source session can be detached from its
   * Bot while its fork is still open.
   *
   * Everything in it comes back from `POST /api/bots/:id/sessions` and none of it is predicted.
   * The panel used to mint the fork's id, name its pane by the sidecar's own rule, and then open a
   * terminal whose context created the session as a side effect of attaching to it -- so the page
   * held a second copy of three decisions the sidecar owns, and the fork reached its Bot only
   * after its first turn had landed. The Bot creates and attaches it now, and this is the receipt.
   */
  const [forkedSession, setForkedSession] = useState<
    {
      sessionId: string;
      title: string;
      /** The pane the Bot started it in. Taken from the Bot, never rebuilt here. */
      tmuxSession: string;
      /** What it was forked FROM, which is the one thing the empty view has to say. */
      sourceTitle: string;
    } | null
  >(null);
  /**
   * Sessions this panel has started fresh, until the catalog has heard of them.
   *
   * Held here for the same reason the fork above is, and it is the same gap: `claude` writes no
   * transcript until its first turn, and the sidecar refuses a Bot reference to a session that is
   * not in the catalog. So there is a window -- one turn long -- in which the session is running,
   * has a name, has a pane, and cannot be attached to anything. The canvas renders it from this
   * list during that window, and the effect below hands it over the moment it can.
   *
   * A list rather than one, unlike the fork, because these are cards on a canvas that already
   * holds as many as the reader opens: starting a second before the first has spoken is an
   * ordinary thing to do, and the fork's single slot would have silently replaced it.
   *
   * Not persisted, deliberately. It is a record the stream is about to own, not an arrangement of
   * the reader's -- so a reload during that window shows the Bot without the card, and the session
   * appears on it a turn later like any other. Storing it would make the panel a second source of
   * truth for which sessions exist.
   */
  const [newSessions, setNewSessions] = useState<readonly NewBotSession[]>([]);

  /** The session whose fork is being named, if any. Nothing is started until it is confirmed. */
  const [forkRequest, setForkRequest] = useState<
    { session: SessionSummary; botId: string; projectPath: string } | null
  >(null);

  // Asks for a name rather than forking. Nothing is started here: the pane, the tmux session and
  // the `claude --fork-session` behind it all wait on the dialog being confirmed, because `-n` is
  // an argument of that command and there is no second chance to set it.
  const forkSession = useCallback((bot: BotView, session: SessionSummary) => {
    if (session.source !== "claude") return;
    setForkRequest({
      session,
      botId: bot.botId,
      projectPath: bot.environment.path,
    });
  }, []);
  const startFork = useCallback(
    async (
      request: { session: SessionSummary; botId: string; projectPath: string },
      forkTitle: string,
      brief: string,
      worktree: boolean,
    ) => {
      setForkRequest(null);
      setBotCommandError(null);
      try {
        const added = await feed.addBotSessions(request.botId, {
          launch: {
            title: forkTitle,
            from: { source: "claude", sessionId: request.session.sessionId },
            ...(brief.trim() ? { prompt: brief } : {}),
            ...(worktree ? { worktree: {} } : {}),
          },
        });
        if (!added.started) return;
        setForkedSession({
          sessionId: added.started.sessionId,
          title: added.started.title,
          tmuxSession: added.started.tmuxSession,
          sourceTitle: request.session.title || request.session.sessionId,
        });
      } catch (error) {
        // Named rather than attributed to a session: the fork does not exist, so there is no card
        // for this to land on. A fork that silently failed to start is indistinguishable from one
        // that was never asked for.
        setBotCommandError({
          session: null,
          message: `Could not fork the session: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
      }
    },
    [feed],
  );

  const startNewSession = useCallback(async (bot: BotView, title: string) => {
    setBotSessionPickerId(null);
    setBotCommandError(null);
    try {
      const added = await feed.addBotSessions(bot.botId, { launch: { title } });
      if (!added.started) return;
      const started = added.started;
      setNewSessions((current) => [
        ...current,
        {
          botId: bot.botId,
          sessionId: started.sessionId,
          title: started.title,
          projectPath: started.projectPath,
          tmuxSession: started.tmuxSession,
        },
      ]);
      setDetachedBotIds((current) => {
        if (!current.has(bot.botId)) return current;
        const next = new Set(current);
        next.delete(bot.botId);
        return next;
      });
      setCanvasOpenKeys((current) => new Set(current).add(`claude:${started.sessionId}`));
    } catch (error) {
      setBotCommandError({
        session: null,
        message: `Could not start the session: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    }
  }, [feed]);

  /** Takes a started session off the canvas. Its tmux session keeps running; see the card. */
  const closeNewSession = useCallback((sessionId: string) => {
    setNewSessions((current) => current.filter((started) => started.sessionId !== sessionId));
  }, []);

  /**
   * The session whose title is being edited, if any.
   *
   * Held by identity rather than by summary so the dialog is opened by the row that has one; the
   * new title is read back from the stream like every other change to a session, so nothing here
   * has to be updated when the rename lands.
   */
  const [renamingSession, setRenamingSession] = useState<SessionSummary | null>(null);
  const renameSession = useCallback(async (session: SessionSummary, title: string) => {
    await feed.renameSession(session.sessionId, title);
    setRenamingSession(null);
  }, [feed]);

  const openBotSessionPicker = useCallback((bot: BotView) => {
    setBotSessionPickerId(bot.botId);
    setHoverPreviewOpen(false);
  }, []);

  const createBot = useCallback(async (command: Omit<AddBotCommand, "requestId">) => {
    await feed.createBot(command);
    setBotCreatorOpen(false);
  }, [feed]);

  const attachBotSessions = useCallback(async (bot: BotView, sessionRefs: BotSessionRef[]) => {
    await feed.addBotSessions(bot.botId, { sessionRefs });
    setBotSessionPickerId(null);
  }, [feed]);

  /**
   * Drops one session from a Bot's projection.
   *
   * Nothing is set here on success: the Bot stream publishes a new snapshot and the row leaves on
   * its own, which is also what happens when the same Bot is edited from another surface. A
   * failure surfaces on the same band the thread's own command errors use, because a removal that
   * silently did nothing is indistinguishable from one that worked.
   */
  const detachBotSession = useCallback((bot: BotView, ref: BotSessionRef) => {
    // A missing reference has no summary to take a title from, which is exactly the row this has
    // to work on, so the id stands in.
    const label = bot.sessions
      .find((session) => session.source === ref.source && session.sessionId === ref.sessionId)
      ?.title || ref.sessionId;
    // Rebuilt field by field rather than forwarded. A `SessionSummary` structurally satisfies
    // `BotSessionRef`, so an attached row hands this its whole summary -- capabilities, title,
    // timestamps -- and passing it straight on would put all of it on the wire.
    const target: BotSessionRef = { source: ref.source, sessionId: ref.sessionId };
    // Cleared as the next removal starts rather than by the open session's own commands: the
    // failure belongs to the Bot edit, so it should outlive a send and not outlive another edit.
    setBotCommandError(null);
    // Forgotten here rather than left to expire with the panel. Hiding a card and then removing
    // the session from the Bot are two different acts, and a leftover key would meet the session
    // again if it were ever attached back -- as an invisible row, on a card that never said so.
    setDetachedSessionKeys((current) => {
      const key = `${target.source}:${target.sessionId}`;
      if (!current.has(key)) return current;
      const next = new Set(current);
      next.delete(key);
      return next;
    });
    void feed
      .detachBotSessions(bot.botId, { sessionRefs: [target] })
      .catch((error: unknown) => {
        // Named: the detach failed, so the session is still on the canvas and its own card is
        // what says the removal did not happen.
        setBotCommandError({
          session: `${target.source}:${target.sessionId}`,
          message: `Could not remove ${label} from ${bot.name}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
      });
  }, [feed]);

  return {
    botCommandError,
    setBotCommandError,
    botCreatorOpen,
    setBotCreatorOpen,
    botSessionPickerId,
    setBotSessionPickerId,
    forkedSession,
    setForkedSession,
    newSessions,
    forkRequest,
    setForkRequest,
    renamingSession,
    setRenamingSession,
    forkSession,
    startFork,
    startNewSession,
    closeNewSession,
    renameSession,
    openBotSessionPicker,
    createBot,
    attachBotSessions,
    detachBotSession,
  };
}
