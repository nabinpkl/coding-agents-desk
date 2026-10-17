// Everything the shell asks a Bot to do, and the failures it reports back.
//
// Creating a Bot, attaching sessions to one, starting a fresh one (forks: `useForkCommands`), renaming
// one, dropping one: all of them are a call to the sidecar and then nothing, because the Bot
// stream publishes a new snapshot and the rows move on their own. What is here is what that
// leaves behind -- the dialogs that are open, the sessions the catalog has not heard of yet, and
// where a failure is said.
//
// It writes into the canvas roster in two places, which is why those are passed in: a started
// session opens its card, and puts its Bot back on the canvas if it was off.

import { useCallback, useState } from "react";
import type {
  BotSessionRef,
  BotView,
  SessionSummary,
} from "@agentdesk/agent-feed-wire";
import type { BotFeeds } from "@/features/bots/botMachines";
import type { BotCommandError } from "@/features/bots/canvas/BotCanvas";
import type { NewBotSession } from "@/features/bots/cards/BotNewSessionCard";
import type { HandoverRequest } from "@/features/bots/dialogs/HandoverDialog";
import { handoverDestination } from "@/features/bots/sessionHandover";
import { useBotRecordCommands } from "@/app/shell-state/useBotRecordCommands";
import { useForkCommands } from "@/app/shell-state/useForkCommands";
import { harnessStart, type NewSessionHarness } from "@/features/bots/dialogs/BotSessionPickerDialog";

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
  // The Bot's own record beside the sessions on it: creation, renames, Fathers, forgetting.
  const record = useBotRecordCommands(feeds, setBotCommandError);
  const [botSessionPickerId, setBotSessionPickerId] = useState<string | null>(null);
  /**
   * Sessions this panel has started fresh, until the catalog has heard of them.
   *
   * Held here for the same reason the fork above is, and it is the same gap: `claude` writes no
   * transcript until its first turn, and the sidecar refuses a Bot reference to a session that is
   * not in the catalog. So there is a window -- one turn long -- in which the session is running,
   * has a name, has a pane, and cannot be attached to anything. The canvas renders it from this
   * list during that window, and the effect below hands it over the moment it can.
   *
   * A list rather than one, because these are cards on a canvas that already holds as many as the
   * reader opens: starting a second before the first has spoken is an ordinary thing to do. Forks
   * asked for from a card land here too, on the card's Bot, which attached them as it started
   * them.
   *
   * Not persisted, deliberately. It is a record the stream is about to own, not an arrangement of
   * the reader's -- so a reload during that window shows the Bot without the card, and the session
   * appears on it a turn later like any other. Storing it would make the panel a second source of
   * truth for which sessions exist.
   */
  const [newSessions, setNewSessions] = useState<readonly NewBotSession[]>([]);

  /**
   * The Claude session being handed to opencode, if any. Nothing is started until it is
   * confirmed: the render reads the transcript at confirm time, so opening the dialog is free
   * and confirming is what pays the one slow read.
   */
  const [handoverRequest, setHandoverRequest] = useState<HandoverRequest | null>(null);

  /**
   * Opens the handover dialog for a Bot's Claude or opencode session.
   *
   * Claude and opencode, in either direction. Codex is absent rather than inert: it is a dormant
   * provider (`AGENTS.md`).
   */
  const handoverSession = useCallback((bot: BotView, session: SessionSummary) => {
    if (!handoverDestination(session)) return;
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
    const destination = handoverDestination(request.session);
    const band = `${request.session.source}:${request.session.sessionId}`;
    if (!destination) {
      // Unreachable through the dialog, which only opens for a session that has one. Said out
      // loud rather than returned quietly, because the quiet version is a confirmed handover that
      // starts nothing and reports nothing.
      setBotCommandError({ session: band, message: "That session has nothing to hand over." });
      return;
    }
    try {
      const feed = feeds.forBot(request.botId);
      if (destination === "claude") {
        // Attached by the sidecar inside the handover, because an attach from here resolves the
        // session against the catalog, which has not seen a Claude session whose first turn is
        // still being written. Opened the way a fresh Bot launch is, as a stand-in card until
        // its transcript lands.
        const { session: started } = await feed.handoverToClaude(
          request.session.sessionId,
          message,
          request.botId,
        );
        setNewSessions((current) => [
          ...current,
          {
            botId: request.botId,
            sessionId: started.sessionId,
            title: started.title,
            projectPath: started.projectPath,
            tmuxSession: started.tmuxSession,
          },
        ]);
        putBotOnCanvas(request.botId);
        setCanvasOpenKeys((current) => new Set(current).add(`claude:${started.sessionId}`));
        return;
      }
      // An opencode session is in the catalog the moment the serve creates it, so it attaches as
      // an ordinary reference.
      const { session: started } = await feed.handoverToOpencode(request.session.sessionId, message);
      await feed.addBotSessions(request.botId, {
        sessionRefs: [{ source: destination, sessionId: started.sessionId }],
      });
      setCanvasOpenKeys((current) => new Set(current).add(`${destination}:${started.sessionId}`));
    } catch (error) {
      setBotCommandError({
        session: band,
        message: `Could not hand over the session: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    }
  }, [feeds, putBotOnCanvas, setCanvasOpenKeys]);

  const forks = useForkCommands(feeds, roster, setBotCommandError, setNewSessions);

  /**
   * An opencode session for a Bot: created at the serve, attached, named, and opened as a card.
   *
   * Four calls where Claude takes one, because the Bot's launch starts Claude panes only. Unlike a
   * fresh Claude session this one is in the catalog the moment the serve creates it, so it attaches
   * at once and opens as an ordinary card -- no stand-in card waiting on a first turn. Naming comes
   * after the attach because the anchor it brackets onto is spent BY the attach.
   */
  const startOpencodeSession = useCallback(async (bot: BotView, task: string) => {
    const feed = feeds.forBot(bot.botId);
    let created: { sessionId: string } | null = null;
    try {
      created = await feed.createSession(bot.environment.path, "opencode");
      await feed.addBotSessions(bot.botId, { sessionRefs: [{ source: "opencode", sessionId: created.sessionId }] });
      putBotOnCanvas(bot.botId);
      setCanvasOpenKeys((current) => new Set(current).add(`opencode:${created!.sessionId}`));
      await feed.setSessionTask("opencode", created.sessionId, task);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      // Said in terms of how far it got: a session that exists but is not on the Bot, or is on it
      // under the serve's own name, is not the same report as one that was never made.
      setBotCommandError(created === null
        ? { session: null, message: `Could not start the opencode session: ${reason}` }
        : {
          session: null,
          message: `The opencode session ${created.sessionId} was created, but setting it up on ${bot.name} failed: ${reason}`,
        });
    }
  }, [feeds, putBotOnCanvas, setCanvasOpenKeys]);

  const startNewSession = useCallback(async (bot: BotView, title: string, harness: NewSessionHarness) => {
    setBotSessionPickerId(null);
    setBotCommandError(null);
    if (harness === "opencode") {
      await startOpencodeSession(bot, title);
      return;
    }
    try {
      const { claudeMode } = harnessStart(harness);
      const added = await feeds.forBot(bot.botId).addBotSessions(bot.botId, {
        launch: { title, ...(claudeMode ? { claudeMode } : {}) },
      });
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
  }, [feeds, putBotOnCanvas, startOpencodeSession]);

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
    ...record,
    botSessionPickerId,
    setBotSessionPickerId,
    ...forks,
    newSessions,
    handoverRequest,
    setHandoverRequest,
    handoverSession,
    startHandover,
    renamingSession,
    setRenamingSession,
    startNewSession,
    closeNewSession,
    renameSession,
    openBotSessionPicker,
    attachBotSessions,
    detachBotSession,
    reorderBotSessions,
  };
}
