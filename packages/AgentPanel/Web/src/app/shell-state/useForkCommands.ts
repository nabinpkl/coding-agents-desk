// Forking a session: naming the fork, starting it, and where it lands.
//
// A fork asked for from a canvas card goes to that card's Bot -- whole, or from a message -- as a
// draft card in its column (`BotForkDraftCard`): its name, first turn, harness and worktree are
// chosen there, and sending starts it into the same `newSessions` list a fresh session uses. A fork
// asked for from the full-width thread view has no Bot, so it is named in the dialog and takes
// over `main` instead.

import { useCallback, useState } from "react";
import type { BotView, SessionSummary } from "@agentdesk/agent-feed-wire";
import type { BotFeeds } from "@/features/bots/botMachines";
import type { BotCommandError } from "@/features/bots/canvas/BotCanvas";
import type { NewBotSession } from "@/features/bots/cards/BotNewSessionCard";
import type { ForkRequest } from "@/features/bots/dialogs/ForkSessionDialog";
import { harnessStart } from "@/features/bots/dialogs/BotSessionPickerDialog";
import type { ForkChoices, ForkDraft } from "@/features/bots/cards/BotForkDraftCard";

export function useForkCommands(
  feeds: BotFeeds,
  roster: {
    putBotOnCanvas: (botId: string) => void;
    setCanvasOpenKeys: React.Dispatch<React.SetStateAction<ReadonlySet<string>>>;
  },
  setBotCommandError: (error: BotCommandError | null) => void,
  setNewSessions: React.Dispatch<React.SetStateAction<readonly NewBotSession[]>>,
) {
  const { putBotOnCanvas, setCanvasOpenKeys } = roster;
  /**
   * A session forked from another with no Bot to land on, and the pane it runs in.
   *
   * Only a fork asked for from the full-width thread view, which has no Bot behind it. A fork asked
   * for from a canvas card goes to that card's Bot and opens as a card in its column instead
   * (`newSessions` below): taking over `main` replaced the whole canvas with one empty session, and
   * the reader lost the card they had forked from in the same click.
   *
   * Everything in it comes back from the session's fork endpoint and none of it is predicted: the
   * id, the title and the pane name are the sidecar's decisions, and this is the receipt.
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
   * A fork with no Bot to land on, being named in the dialog: only the full-width thread view asks
   * for one. A fork onto a Bot is a draft card instead (`forkDrafts`).
   */
  const [forkRequest, setForkRequest] = useState<ForkRequest | null>(null);
  const [forkDrafts, setForkDrafts] = useState<readonly ForkDraft[]>([]);

  /** A fork asked for: a draft card on its Bot, or the dialog for a fork that has no Bot. */
  const askFork = useCallback((request: ForkRequest) => {
    const { botId } = request;
    if (botId === undefined) {
      setForkRequest(request);
      return;
    }
    setForkDrafts((current) => [...current, { key: `fork-draft:${crypto.randomUUID()}`, request: { ...request, botId } }]);
    putBotOnCanvas(botId);
  }, [putBotOnCanvas]);
  const closeForkDraft = useCallback((key: string) => {
    setForkDrafts((current) => current.filter((draft) => draft.key !== key));
  }, []);
  // Asks for a name rather than forking. Nothing is started here: the pane, the tmux session and
  // the `claude --fork-session` behind it all wait on the dialog being confirmed, because `-n` is
  // an argument of that command and there is no second chance to set it.
  const forkSession = useCallback((bot: BotView, session: SessionSummary) => {
    if (session.source !== "claude") return;
    askFork({
      session,
      botId: bot.botId,
      projectPath: bot.environment.path,
    });
  }, [askFork]);

  /**
   * The same dialog, opened from a message rather than from a roster row.
   *
   * On a canvas card the card says which Bot it is, and the fork lands on that Bot as a card beside
   * its source. The full-width thread view has no Bot to name, so a fork asked for there goes
   * through the session endpoint and lands in the catalog on its own.
   */
  const forkFromMessage = useCallback((request: {
    session: SessionSummary;
    projectPath: string;
    message: { eventId: string; text: string };
    botId?: string;
  }) => {
    if (request.session.source !== "claude") return;
    askFork({
      session: request.session,
      projectPath: request.projectPath,
      ...(request.botId === undefined ? {} : { botId: request.botId }),
      from: request.message,
    });
  }, [askFork]);

  /**
   * The same dialog again, from the session's own ⋮ rather than from a message.
   *
   * The message is looked up instead of picked. A reader who wants to branch from the last thing
   * they said would otherwise have to scroll back to that row to reach its menu, and one turn of
   * tool calls is enough to put it off the screen -- so the affordance was furthest away exactly
   * when it was most wanted.
   *
   * The Bot is carried through, so the fork lands on it as a card beside its source.
   */
  const forkFromLastMessage = useCallback(async (bot: BotView, session: SessionSummary) => {
    if (session.source !== "claude") return;
    setBotCommandError(null);
    try {
      askFork({
        session,
        projectPath: bot.environment.path,
        botId: bot.botId,
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
  }, [askFork, feeds]);

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
  const forkFromLastCompaction = useCallback(async (bot: BotView, session: SessionSummary) => {
    if (session.source !== "claude") return;
    setBotCommandError(null);
    try {
      askFork({
        session,
        projectPath: bot.environment.path,
        botId: bot.botId,
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
  }, [askFork, feeds]);

  /** Starts a fork with no Bot, named in the dialog: it takes over `main` as `forkedSession`. */
  const startFork = useCallback(
    async (
      request: ForkRequest,
      forkTitle: string,
      brief: string,
      worktree: boolean,
    ) => {
      setForkRequest(null);
      setBotCommandError(null);
      const sourceTitle = request.session.title || request.session.sessionId;
      try {
        if (!request.from) throw new Error("a fork of a whole session must name the Bot to attach it to");
        const started = await feeds.forSession(request.session).forkSession(request.session.sessionId, {
          title: forkTitle,
          ...(brief.trim() ? { prompt: brief } : {}),
          ...(worktree ? { worktree: {} } : {}),
          from: { eventId: request.from.eventId },
        });
        setForkedSession({
          sessionId: started.sessionId,
          title: started.title,
          tmuxSession: started.tmuxSession,
          sourceTitle,
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

  /**
   * Starts a draft with what was chosen on its card, answering why not when it does not start: the
   * draft stays, with every word the reader typed, so a refusal costs them nothing (the error rides
   * the card rather than the canvas, because the card is where they are).
   */
  const startForkDraft = useCallback(async (key: string, choices: ForkChoices): Promise<string | null> => {
    const draft = forkDrafts.find((each) => each.key === key);
    if (!draft) return "This fork is no longer waiting to start.";
    const { request } = draft;
    const { botId } = request;
    const feed = feeds.forBot(botId);
    const brief = choices.brief.trim() ? choices.brief : undefined;
    try {
      if (choices.harness === "opencode") {
        // opencode holds no Claude history, so its fork is a handover: the conversation rendered
        // as one first turn, the reader's words after it, attached as an ordinary reference.
        const { session: started } = await feed.handoverToOpencode(request.session.sessionId, brief);
        await feed.addBotSessions(botId, { sessionRefs: [{ source: "opencode", sessionId: started.sessionId }] });
        // Always, as a fresh opencode session's is: the attach spent the Bot's anchor, and this is
        // what puts it on the session, with the task bracketed after it when there is one.
        await feed.setSessionTask("opencode", started.sessionId, choices.task.trim());
        setCanvasOpenKeys((current) => new Set(current).add(`opencode:${started.sessionId}`));
      } else {
        const { claudeMode } = harnessStart(choices.harness);
        const { started } = await feed.addBotSessions(botId, {
          launch: {
            title: choices.task.trim(),
            ...(brief === undefined ? {} : { prompt: brief }),
            ...(choices.worktree ? { worktree: {} } : {}),
            ...(claudeMode ? { claudeMode } : {}),
            from: {
              source: "claude",
              sessionId: request.session.sessionId,
              ...(request.from ? { eventId: request.from.eventId } : {}),
            },
          },
        });
        if (!started) return "The Bot did not start the fork.";
        setNewSessions((current) => [
          ...current,
          {
            botId,
            sessionId: started.sessionId,
            title: started.title,
            projectPath: started.projectPath,
            tmuxSession: started.tmuxSession,
            forkedFrom: request.session.title || request.session.sessionId,
            ...(started.rewindFailed ? { rewindFailed: started.rewindFailed } : {}),
          },
        ]);
        setCanvasOpenKeys((current) => new Set(current).add(`claude:${started.sessionId}`));
      }
      closeForkDraft(key);
      return null;
    } catch (error) {
      return `Could not start the fork: ${error instanceof Error ? error.message : String(error)}`;
    }
  }, [closeForkDraft, feeds, forkDrafts, setCanvasOpenKeys, setNewSessions]);

  return {
    forkDrafts,
    startForkDraft,
    closeForkDraft,
    forkedSession,
    setForkedSession,
    forkRequest,
    setForkRequest,
    forkSession,
    forkFromMessage,
    forkFromLastMessage,
    forkFromLastCompaction,
    startFork,
  };
}
