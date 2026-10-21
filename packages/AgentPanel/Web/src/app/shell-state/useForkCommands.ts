// Forking a session: naming the fork, starting it, and where it lands.
//
// A fork asked for from a canvas card goes to that card's Bot -- whole, or from a message -- as a
// draft card in its column (`useSessionDrafts`): its name, first turn, harness and worktree are
// chosen there, and sending starts it. A fork asked for from the full-width thread view has no
// Bot, so it is named in the dialog and takes over `main` instead.

import { useCallback, useState } from "react";
import type { BotView, SessionSummary } from "@agentdesk/agent-feed-wire";
import type { BotFeeds } from "@/features/bots/botMachines";
import type { BotCommandError } from "@/features/bots/canvas/BotCanvas";
import type { ForkRequest } from "@/features/bots/dialogs/ForkSessionDialog";
import type { SessionDraft } from "@/features/bots/cards/BotSessionDraftCard";

export function useForkCommands(
  feeds: BotFeeds,
  /** Puts a draft card on a Bot: where a fork asked for from a canvas card waits to be sent. */
  addDraft: (draft: Omit<SessionDraft, "key">) => void,
  setBotCommandError: (error: BotCommandError | null) => void,
) {
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
  const [forkedSession, setForkedSession] = useState<{
    sessionId: string;
    title: string;
    /** The pane the Bot started it in. Taken from the Bot, never rebuilt here. */
    tmuxSession: string;
    /** What it was forked FROM, which is the one thing the empty view has to say. */
    sourceTitle: string;
    /** Why it could not be moved back to the message it was asked to start from, if it was. */
    rewindFailed?: string;
  } | null>(null);

  /**
   * A fork with no Bot to land on, being named in the dialog: only the full-width thread view asks
   * for one. A fork onto a Bot is a draft card instead (`useSessionDrafts`).
   */
  const [forkRequest, setForkRequest] = useState<ForkRequest | null>(null);

  /** A fork asked for: a draft card on its Bot, or the dialog for a fork that has no Bot. */
  const askFork = useCallback(
    (request: ForkRequest) => {
      const { botId } = request;
      if (botId === undefined) {
        setForkRequest(request);
        return;
      }
      addDraft({ botId, fork: request, task: "", harness: "claude" });
    },
    [addDraft],
  );
  // Asks for a name rather than forking. Nothing is started here: the pane, the tmux session and
  // the `claude --fork-session` behind it all wait on the dialog being confirmed, because `-n` is
  // an argument of that command and there is no second chance to set it.
  const forkSession = useCallback(
    (bot: BotView, session: SessionSummary) => {
      if (session.source !== "claude") return;
      askFork({
        session,
        botId: bot.botId,
        projectPath: bot.environment.path,
      });
    },
    [askFork],
  );

  /**
   * The same dialog, opened from a message rather than from a roster row.
   *
   * On a canvas card the card says which Bot it is, and the fork lands on that Bot as a card beside
   * its source. The full-width thread view has no Bot to name, so a fork asked for there goes
   * through the session endpoint and lands in the catalog on its own.
   */
  const forkFromMessage = useCallback(
    (request: {
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
    },
    [askFork],
  );

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
  const forkFromLastMessage = useCallback(
    async (bot: BotView, session: SessionSummary) => {
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
          message: `Could not find the last message: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    },
    [askFork, feeds, setBotCommandError],
  );

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
  const forkFromLastCompaction = useCallback(
    async (bot: BotView, session: SessionSummary) => {
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
    },
    [askFork, feeds, setBotCommandError],
  );

  /** Starts a fork with no Bot, named in the dialog: it takes over `main` as `forkedSession`. */
  const startFork = useCallback(
    async (request: ForkRequest, forkTitle: string, brief: string, worktree: boolean) => {
      setForkRequest(null);
      setBotCommandError(null);
      const sourceTitle = request.session.title || request.session.sessionId;
      // Answered here rather than thrown into the `catch` below, which React Compiler cannot lower.
      if (!request.from) {
        setBotCommandError({
          session: null,
          message: "Could not fork the session: a fork of a whole session must name the Bot to attach it to",
        });
        return;
      }
      const from = request.from;
      try {
        const started = await feeds.forSession(request.session).forkSession(request.session.sessionId, {
          title: forkTitle,
          ...(brief.trim() ? { prompt: brief } : {}),
          ...(worktree ? { worktree: {} } : {}),
          from: { eventId: from.eventId },
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
          message: `Could not fork the session: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    },
    [feeds, setBotCommandError],
  );

  return {
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
