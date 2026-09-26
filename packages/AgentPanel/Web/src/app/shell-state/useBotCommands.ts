// Everything the shell asks a Bot to do, and the failures it reports back.
//
// Creating a Bot, attaching sessions to one, forking a session, starting a fresh one, renaming
// one, dropping one: all of them are a call to the sidecar and then nothing, because the Bot
// stream publishes a new snapshot and the rows move on their own. What is here is what that
// leaves behind -- the dialogs that are open, the sessions the catalog has not heard of yet, and
// where a failure is said.
//
// It writes into the canvas roster in two places, which is why those are passed in: a started
// session opens its card, and puts its Bot back on the canvas if it was off.

import { useCallback, useState } from "react";
import type {
  AddBotCommand,
  BotSessionRef,
  BotView,
  SessionSummary,
} from "@agentdesk/agent-feed-wire";
import type { BotFeeds, BotMachine } from "@/features/bots/botMachines";
import type { BotCommandError } from "@/features/bots/canvas/BotCanvas";
import type { NewBotSession } from "@/features/bots/cards/BotNewSessionCard";
import type { ForkRequest } from "@/features/bots/dialogs/ForkSessionDialog";
import type { HandoverRequest } from "@/features/bots/dialogs/HandoverDialog";

/**
 * The Bot a whole-session fork attaches to.
 *
 * Thrown rather than defaulted, because there is no sensible Bot to guess: a fork with neither a
 * message to start from nor a Bot to land on is a request that was built wrong, and sending
 * `undefined` in the path would ask the sidecar about a Bot called "undefined" instead.
 */
function requireBot(request: ForkRequest): string {
  if (request.botId) return request.botId;
  throw new Error("a fork of a whole session must name the Bot to attach it to");
}

export function useBotCommands(
  /**
   * Which sidecar each command goes to, rather than the one sidecar it used to be.
   *
   * A Bot's record lives on the machine whose directory it names (`botMachines.ts`), so every call
   * below is addressed at a machine and not merely at an id. The resolution reads the CURRENT
   * roster at the moment a command is issued rather than the one that rendered the button, which is
   * what lets this object stay identity-stable while the roster moves under it -- see `useBots`.
   */
  feeds: BotFeeds,
  roster: {
    /** Puts a Bot that is off the canvas back on it, on its record. */
    putBotOnCanvas: (botId: string) => void;
    setCanvasOpenKeys: React.Dispatch<React.SetStateAction<ReadonlySet<string>>>;
  },
  /** Dropped whenever a picker or dialog opens, so a peek never stacks over the thing it opened. */
  setHoverPreviewOpen: (open: boolean) => void,
) {
  const { setCanvasOpenKeys, putBotOnCanvas } = roster;
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
      /** Why it could not be moved back to the message it was asked to start from, if it was. */
      rewindFailed?: string;
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
  const [forkRequest, setForkRequest] = useState<ForkRequest | null>(null);

  /**
   * The Claude session being handed to opencode, if any. Nothing is started until it is
   * confirmed: the render reads the transcript at confirm time, so opening the dialog is free
   * and confirming is what pays the one slow read.
   */
  const [handoverRequest, setHandoverRequest] = useState<HandoverRequest | null>(null);

  /**
   * Opens the handover dialog for a Bot's Claude session.
   *
   * Claude-only like the forks, and absent rather than inert elsewhere: the render reads Claude
   * records, and Codex and opencode rows have nothing it can hand over.
   */
  const handoverToOpencode = useCallback((bot: BotView, session: SessionSummary) => {
    if (session.source !== "claude") return;
    setHandoverRequest({ botId: bot.botId, session, projectPath: bot.environment.path });
  }, []);

  /**
   * Starts the opencode session, attaches it to the asking Bot, and opens its card.
   *
   * The dialog closes first for `startFork`'s reason: what follows takes one slow transcript
   * read plus a model turn to start, and a modal held open across both is a wait with no
   * progress to show. A failure lands on the canvas band named against the source session,
   * which is still on screen holding the menu that asked.
   */
  const startHandover = useCallback(async (request: HandoverRequest, message: string) => {
    setHandoverRequest(null);
    setBotCommandError(null);
    try {
      const feed = feeds.forBot(request.botId);
      const { session: started } = await feed.handoverToOpencode(request.session.sessionId, message);
      await feed.addBotSessions(request.botId, {
        sessionRefs: [{ source: "opencode", sessionId: started.sessionId }],
      });
      setCanvasOpenKeys((current) => new Set(current).add(`opencode:${started.sessionId}`));
    } catch (error) {
      setBotCommandError({
        session: `claude:${request.session.sessionId}`,
        message: `Could not hand over the session: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    }
  }, [feeds, setCanvasOpenKeys]);

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

  /**
   * The same dialog, opened from a message rather than from a roster row.
   *
   * No Bot, and that is the point: a reader decides to branch while READING, and the transcript
   * view has no Bot to hang the request on. The fork goes through the session endpoint instead and
   * lands in the catalog on its own, the way a session started anywhere else does.
   */
  const forkFromMessage = useCallback((request: {
    session: SessionSummary;
    projectPath: string;
    message: { eventId: string; text: string };
  }) => {
    if (request.session.source !== "claude") return;
    setForkRequest({
      session: request.session,
      projectPath: request.projectPath,
      from: request.message,
    });
  }, []);

  /**
   * The same dialog again, from the session's own ⋮ rather than from a message.
   *
   * The message is looked up instead of picked. A reader who wants to branch from the last thing
   * they said would otherwise have to scroll back to that row to reach its menu, and one turn of
   * tool calls is enough to put it off the screen -- so the affordance was furthest away exactly
   * when it was most wanted.
   *
   * The Bot is deliberately NOT carried through. This goes to the session endpoint like every
   * other fork from a message, so it lands in the catalog on its own rather than on the Bot the
   * row happened to be read from; see `forkFromMessage`.
   */
  const forkFromLastMessage = useCallback(async (session: SessionSummary, projectPath: string) => {
    if (session.source !== "claude") return;
    setBotCommandError(null);
    try {
      setForkRequest({
        session,
        projectPath,
        from: await feeds.forSession(session).lastMessage(session.sessionId),
      });
    } catch (error) {
      // Named against the session, unlike a failed fork: this one failed before anything was
      // started, so the card it was asked from is still there to say so on.
      setBotCommandError({
        session: `${session.source}:${session.sessionId}`,
        message: `Could not find the last message: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    }
  }, [feeds]);

  /**
   * The same dialog again, anchored at the last compaction rather than the last message.
   *
   * What a reader wants after a turn that went the wrong way with a summarised context behind it:
   * a session holding the compaction summary and none of what followed. A plain fork does not give
   * that -- it inherits everything after the summary too -- and finding the right row by hand means
   * scrolling back past the whole wrong turn to the message under the compaction banner.
   *
   * The sidecar decides which row that is, for `forkFromLastMessage`'s reason and one more: a
   * compaction is two records the panel draws as one banner, and which message sits after them is
   * a question about a file rather than about what happens to be rendered.
   */
  const forkFromLastCompaction = useCallback(async (session: SessionSummary, projectPath: string) => {
    if (session.source !== "claude") return;
    setBotCommandError(null);
    try {
      setForkRequest({
        session,
        projectPath,
        from: await feeds.forSession(session).lastCompaction(session.sessionId),
      });
    } catch (error) {
      setBotCommandError({
        session: `${session.source}:${session.sessionId}`,
        message: `Could not find a compaction to fork from: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    }
  }, [feeds]);

  const startFork = useCallback(
    async (
      request: ForkRequest,
      forkTitle: string,
      brief: string,
      worktree: boolean,
    ) => {
      setForkRequest(null);
      setBotCommandError(null);
      try {
        // Resolved once: `requireBot` throws when a whole-session fork names no Bot, and calling it
        // twice would leave the machine lookup and the path disagreeing about which id they meant.
        const forkTarget = request.from ? "" : requireBot(request);
        // Two endpoints, because they answer two different questions. A fork asked for from a Bot
        // row is a session FOR that Bot and has to arrive attached to it; a fork asked for from a
        // message belongs to nobody but the reader, and only the session endpoint takes the
        // message to start before.
        const started = request.from
          ? await feeds.forSession(request.session).forkSession(request.session.sessionId, {
            title: forkTitle,
            from: { eventId: request.from.eventId },
            ...(brief.trim() ? { prompt: brief } : {}),
            ...(worktree ? { worktree: {} } : {}),
          })
          : (await feeds.forBot(forkTarget).addBotSessions(forkTarget, {
            launch: {
              title: forkTitle,
              from: { source: "claude", sessionId: request.session.sessionId },
              ...(brief.trim() ? { prompt: brief } : {}),
              ...(worktree ? { worktree: {} } : {}),
            },
          })).started;
        if (!started) return;
        setForkedSession({
          sessionId: started.sessionId,
          title: started.title,
          tmuxSession: started.tmuxSession,
          sourceTitle: request.session.title || request.session.sessionId,
          // Carried rather than swallowed. The fork EXISTS and is running -- it just holds the
          // whole conversation instead of the slice that was asked for -- and a reader told
          // nothing would believe they had branched from their message when they had not.
          ...(started.rewindFailed ? { rewindFailed: started.rewindFailed } : {}),
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
    [feeds],
  );

  const startNewSession = useCallback(async (bot: BotView, title: string) => {
    setBotSessionPickerId(null);
    setBotCommandError(null);
    try {
      const added = await feeds.forBot(bot.botId).addBotSessions(bot.botId, { launch: { title } });
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
      putBotOnCanvas(bot.botId);
      setCanvasOpenKeys((current) => new Set(current).add(`claude:${started.sessionId}`));
    } catch (error) {
      setBotCommandError({
        session: null,
        message: `Could not start the session: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    }
  }, [feeds, putBotOnCanvas]);

  /** Takes a started session off the canvas. Its tmux session keeps running; see the card. */
  const closeNewSession = useCallback((sessionId: string) => {
    setNewSessions((current) => current.filter((started) => started.sessionId !== sessionId));
  }, []);

  /**
   * The session whose title is being edited, if any.
   *
   * Held by identity rather than by summary so the dialog is opened by the row that has one. Which
   * sources may be renamed at all is `canRenameSession`'s answer, asked where the menu is built;
   * the new title is read back from the stream like every other change to a session, so nothing
   * here has to be updated when the rename lands.
   */
  const [renamingSession, setRenamingSession] = useState<SessionSummary | null>(null);
  const renameSession = useCallback(async (session: SessionSummary, title: string) => {
    await feeds.forSession(session).renameSession(session.source, session.sessionId, title);
    setRenamingSession(null);
  }, [feeds]);

  const openBotSessionPicker = useCallback((bot: BotView) => {
    setBotSessionPickerId(bot.botId);
    setHoverPreviewOpen(false);
  }, []);

  /**
   * Creates a Bot on the machine whose directory it names.
   *
   * The machine is an argument rather than a lookup, because this is the one command with no Bot to
   * resolve from: the directory is on that machine, its sessions are on that machine, and the
   * registry that will own the record is that machine's. The dialog picks it, since the dialog is
   * where the reader picked the folder.
   */
  const createBot = useCallback(async (
    command: Omit<AddBotCommand, "requestId">,
    machine: BotMachine,
  ) => {
    await machine.feed.createBot(command);
    setBotCreatorOpen(false);
  }, []);

  const attachBotSessions = useCallback(async (bot: BotView, sessionRefs: BotSessionRef[]) => {
    await feeds.forBot(bot.botId).addBotSessions(bot.botId, { sessionRefs });
    setBotSessionPickerId(null);
  }, [feeds]);

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
    // Nothing to forget about its place on the canvas: the sidecar drops the session from the
    // Bot's off-canvas list in the same write that detaches it.
    void Promise.resolve()
      .then(() => feeds.forBot(bot.botId).detachBotSessions(bot.botId, { sessionRefs: [target] }))
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
  }, [feeds]);

  /**
   * Stands one Bot's sessions in a new order.
   *
   * Nothing is set here on success, for `detachBotSession`'s reason: the Bot stream publishes the
   * new snapshot and the cards move on their own, which is also what happens when the same Bot is
   * rearranged from another surface or another machine. Until it arrives the cards sit where they
   * were, so a reorder looks like a drag that sprang back for as long as the round trip takes.
   *
   * A failure is named against the session that was carried rather than dropped on the canvas
   * band, because that card is still on screen and still in its old place: an order that silently
   * did not take is indistinguishable from a drag that missed.
   */
  const reorderBotSessions = useCallback(
    (bot: BotView, sessionRefs: BotSessionRef[], moved: BotSessionRef) => {
      const label = bot.sessions
        .find((session) => session.source === moved.source && session.sessionId === moved.sessionId)
        ?.title || moved.sessionId;
      setBotCommandError(null);
      void Promise.resolve()
        .then(() => feeds.forBot(bot.botId).reorderBotSessions(bot.botId, { sessionRefs }))
        .catch((error: unknown) => {
          setBotCommandError({
            session: `${moved.source}:${moved.sessionId}`,
            message: `Could not move ${label} in ${bot.name}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          });
        });
    },
    [feeds],
  );

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
    handoverRequest,
    setHandoverRequest,
    handoverToOpencode,
    startHandover,
    renamingSession,
    setRenamingSession,
    forkSession,
    forkFromMessage,
    forkFromLastMessage,
    forkFromLastCompaction,
    startFork,
    startNewSession,
    closeNewSession,
    renameSession,
    openBotSessionPicker,
    createBot,
    attachBotSessions,
    detachBotSession,
    reorderBotSessions,
  };
}
