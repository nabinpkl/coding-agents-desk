// The turn-finished notifier wired to the live catalog, the Bot store, the push fan-out and the
// Mac's audio channel.

import type { BotRecord } from "@agentdesk/agent-feed-wire";
import type { BotStore } from "@/bots/botStore";
import { config } from "@/config/config";
import { pushToAll } from "@/push/pushFanout";
import { sendPush } from "@/push/pushSender";
import { holdsSenderLease } from "@/push/pushSenderLease";
import { speakSession } from "@/push/sessionSpeech";
import { createSessionVoices } from "@/push/sessionVoices";
import { fileReminderStore } from "@/push/speechReminders";
import { startTurnFinishedNotifier } from "@/push/turnFinishedNotifier";
import { catalogReady, getSnapshot, subscribeCatalog } from "@/transcripts/catalog/transcriptCatalog";
import type { Session } from "@/transcripts/transcriptTypes";

export function startLiveTurnFinishedNotifier(botStore: Pick<BotStore, "snapshot" | "mutate">): () => void {
  if (!config.pushTurnFinished) return () => {};
  let stop = (): void => {};
  let stopped = false;
  const voices = createSessionVoices(botStore);
  /** A Bot's session in its own voice; a failure to give one is logged and it speaks in the voice in use. */
  const voiceOf = (bot: BotRecord, session: Session): Promise<string | null> =>
    voices.voiceOf(bot.botId, `${session.source}:${session.sessionId}`).catch((error: unknown) => {
      console.error(`[speech] could not give ${bot.name}'s session a voice`, error);
      return null;
    });
  // After the catalog's first full read, so the baseline is every session rather than the first few
  // the scan reached.
  void catalogReady().then(() => {
    if (stopped) return;
    stop = startTurnFinishedNotifier({
      subscribe: (listener) => {
        const unsubscribe = subscribeCatalog(listener);
        listener(getSnapshot());
        return unsubscribe;
      },
      bots: async () => (await botStore.snapshot()).bots,
      push: async (payload) => {
        const outcomes = await pushToAll(config.webPushPath, payload, config.webPushSubject, sendPush);
        const answered = outcomes.map((outcome) => `${new URL(outcome.endpoint).host} ${outcome.status}`).join(", ");
        console.log(`[push] ${payload.tag}: ${answered || "no device subscribed"}`);
      },
      announce: async (bot, session, occasion) =>
        speakSession(bot, session, occasion, bot ? await voiceOf(bot, session) : null),
      mayPush: () => holdsSenderLease(config.webPushSenderPath),
      // The quiet window, not a poll: one timer per closed turn, cancelled if the turn reopens.
      schedule: (work, ms) => {
        // `work` catches its own failure; its promise is only for a test to await.
        const timer = setTimeout(() => void work(), ms);
        return () => clearTimeout(timer);
      },
      quietMs: config.pushQuietMs,
      questionQuietMs: config.pushQuestionQuietMs,
      remindMs: config.speechRemindMs,
      reminderStore: fileReminderStore(config.speechRemindersPath),
      now: Date.now,
    });
  });
  return () => {
    stopped = true;
    stop();
  };
}
