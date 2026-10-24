// Sessions on a Bot that have not started: a fork asked for from a card, or a fresh session asked
// for from the Add sessions dialog. Each is a draft card in its Bot's row (`BotSessionDraftCard`)
// until the reader sends its first message, and sending is what starts it, into the same
// `newSessions` list every started session waits in until its transcript lands.
//
// Nothing runs before then. A Claude session started with no first turn writes no transcript, so
// it is a process nothing can resume: a relaunch finds no conversation and leaves an empty pane.

import { useCallback, useState } from "react";
import type { BotFeeds } from "@/features/bots/botMachines";
import type { NewBotSession } from "@/features/bots/cards/BotNewSessionCard";
import type { DraftChoices, SessionDraft } from "@/features/bots/cards/BotSessionDraftCard";
import { harnessStart } from "@/features/bots/dialogs/BotSessionPickerDialog";

export function useSessionDrafts(
  feeds: BotFeeds,
  roster: {
    putBotOnCanvas: (botId: string) => void;
    setCanvasOpenKeys: React.Dispatch<React.SetStateAction<ReadonlySet<string>>>;
  },
  setNewSessions: React.Dispatch<React.SetStateAction<readonly NewBotSession[]>>,
) {
  const { putBotOnCanvas, setCanvasOpenKeys } = roster;
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
      const brief = choices.brief.trim() ? choices.brief : undefined;
      try {
        if (choices.harness === "opencode") {
          // The card offers opencode only for a whole fork; a fresh one is started by the dialog.
          if (!fork) return "opencode starts from the Add sessions dialog.";
          // opencode holds no Claude history, so its fork is a handover: the conversation rendered
          // as one first turn, the reader's words after it, attached as an ordinary reference.
          const { session: started } = await feed.handoverToOpencode(fork.session.sessionId, brief);
          // Beside its source, where its draft was; a Claude fork stands there without being told.
          await feed.addBotSessions(botId, {
            sessionRefs: [{ source: "opencode", sessionId: started.sessionId }],
            after: { source: "claude", sessionId: fork.session.sessionId },
          });
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
          setCanvasOpenKeys((current) => new Set(current).add(`claude:${started.sessionId}`));
        }
        closeDraft(key);
        return null;
      } catch (error) {
        return `Could not start the ${noun}: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
    [closeDraft, feeds, sessionDrafts, setCanvasOpenKeys, setNewSessions],
  );

  return { sessionDrafts, addDraft, startDraft, closeDraft };
}
