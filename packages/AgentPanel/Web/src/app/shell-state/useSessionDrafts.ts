// Sessions on a Bot that have not started: a fork asked for from a card, or a fresh session asked
// for with its Bot's + (or from the Add sessions dialog). Each is a draft card in its Bot's row
// (`BotSessionDraftCard`) until the reader sends its first message, and sending is what starts it,
// into the same `newSessions` list every started session waits in until its transcript lands.
//
// Nothing runs before then. A Claude session started with no first turn writes no transcript, so
// it is a process nothing can resume: a relaunch finds no conversation and leaves an empty pane.

import { useCallback, useState } from "react";
import type { BotSessionRef } from "@agentdesk/agent-feed-wire";
import type { BotFeeds } from "@/features/bots/botMachines";
import type { NewBotSession } from "@/features/bots/session-cards/BotNewSessionCard";
import type { DraftChoices, SessionDraft } from "@/features/bots/session-cards/BotSessionDraftCard";
import { harnessStart } from "@/features/bots/dialogs/BotSessionPickerDialog";

/**
 * What a fork asked to answer a question about a passage is sent as its first turn: what it is
 * for, the passage, then the reader's question.
 *
 * It holds the whole conversation and no sense that the conversation is borrowed, so this is the
 * moment to say the work in it is not its own. Said a turn later, it has already had a turn to
 * carry on where the session it came from left off.
 */
export function askAboutPrompt(quote: string, question: string): string {
  return [
    "You are a fork of the conversation above, started only to answer a question about one passage in it.",
    "Answer the question and stop. You may read files and search to answer it, but change nothing, and do " +
      "not carry on with the conversation's work: the session you were forked from carries on without you.",
    "",
    "The passage:",
    "",
    quote
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n"),
    "",
    question.trim(),
  ].join("\n");
}

export function useSessionDrafts(
  feeds: BotFeeds,
  roster: {
    putBotOnCanvas: (botId: string) => void;
    /** Opens a started session's card, and keeps it on the canvas the draft was on. */
    openStartedSession: (botId: string, ref: BotSessionRef) => void;
  },
  setNewSessions: React.Dispatch<React.SetStateAction<readonly NewBotSession[]>>,
) {
  const { putBotOnCanvas, openStartedSession } = roster;
  const [sessionDrafts, setSessionDrafts] = useState<readonly SessionDraft[]>([]);

  /** A draft card on its Bot, which is put back on the canvas if it was off, so the card is seen. */
  const addDraft = useCallback(
    (draft: Omit<SessionDraft, "key">) => {
      setSessionDrafts((current) => [...current, { ...draft, key: `session-draft:${crypto.randomUUID()}` }]);
      putBotOnCanvas(draft.botId);
    },
    [putBotOnCanvas],
  );

  const closeDraft = useCallback((key: string) => {
    setSessionDrafts((current) => current.filter((draft) => draft.key !== key));
  }, []);

  /**
   * Starts a draft with what was chosen on its card, answering why not when it does not start: the
   * draft stays, with every word the reader typed, so a refusal costs them nothing (the error rides
   * the card rather than the canvas, because the card is where they are).
   */
  const startDraft = useCallback(
    async (key: string, choices: DraftChoices): Promise<string | null> => {
      const draft = sessionDrafts.find((each) => each.key === key);
      if (!draft) return "This session is no longer waiting to start.";
      const { botId, fork } = draft;
      const noun = fork ? "fork" : "session";
      const feed = feeds.forBot(botId);
      const typed = choices.brief.trim() ? choices.brief : undefined;
      const brief = typed !== undefined && fork?.ask ? askAboutPrompt(fork.ask.quote, typed) : typed;
      try {
        if (choices.harness === "opencode") {
          // The card offers opencode only for a whole fork; a fresh one is started by the dialog.
          if (!fork) return "opencode starts from the Add sessions dialog.";
          // opencode holds no Claude history, so its fork is a handover: the conversation rendered
          // as one first turn, the reader's words after it, attached as an ordinary reference.
          // The sidecar names it before that turn, by the task typed or else its source's, the way
          // a Claude fork starts; the Bot's title queue puts the anchor the attach spends in front.
          const task = choices.task.trim() || undefined;
          const { session: started } = await feed.handoverToOpencode(fork.session.sessionId, brief, task);
          // Beside its source, where its draft was; a Claude fork stands there without being told.
          await feed.addBotSessions(botId, {
            sessionRefs: [{ source: "opencode", sessionId: started.sessionId }],
            after: { source: "claude", sessionId: fork.session.sessionId },
          });
          openStartedSession(botId, { source: "opencode", sessionId: started.sessionId });
        } else {
          const { claudeMode } = harnessStart(choices.harness);
          const { started } = await feed.addBotSessions(botId, {
            launch: {
              title: choices.task.trim(),
              ...(brief === undefined ? {} : { prompt: brief }),
              ...(choices.worktree ? { worktree: {} } : {}),
              ...(claudeMode ? { claudeMode } : {}),
              ...(fork
                ? {
                    from: {
                      source: "claude",
                      sessionId: fork.session.sessionId,
                      ...(fork.from ? { eventId: fork.from.eventId } : {}),
                    },
                  }
                : {}),
            },
          });
          if (!started) return `The Bot did not start the ${noun}.`;
          setNewSessions((current) => [
            ...current,
            {
              botId,
              sessionId: started.sessionId,
              title: started.title,
              projectPath: started.projectPath,
              tmuxSession: started.tmuxSession,
              ...(fork ? { forkedFrom: fork.session.title || fork.session.sessionId } : {}),
              ...(started.rewindFailed ? { rewindFailed: started.rewindFailed } : {}),
              ...(brief === undefined ? {} : { firstTurn: true }),
            },
          ]);
          openStartedSession(botId, { source: "claude", sessionId: started.sessionId });
        }
        closeDraft(key);
        return null;
      } catch (error) {
        return `Could not start the ${noun}: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
    [closeDraft, feeds, openStartedSession, sessionDrafts, setNewSessions],
  );

  return { sessionDrafts, addDraft, startDraft, closeDraft };
}
