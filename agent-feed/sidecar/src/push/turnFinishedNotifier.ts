// A push when a Claude session in a Bot finishes its turn.
//
// The signal is the catalog's, not a live connection's: the catalog watches every Claude transcript
// all the time and keeps `lastTurnClosed` for each session (an assistant record ending on
// `end_turn` closes the turn, a user record opens it). The SDK client and the live sources connect
// only while a panel is looking, which is exactly when a notification is not needed.
//
// The rules, each for a reason:
// - The first catalog snapshot only records where every session stands. A restart (every save
//   under `bun --watch`) must not announce every turn that was already closed.
// - Only a session seen open and then closed notifies. A session first seen already closed was
//   discovered, not finished.
// - A close waits out a quiet window before it is sent, and a turn that opens again inside it sends
//   nothing: a queued prompt, an agent that carries straight on, a background job that wakes it.
// - Background jobs are not tracked: an agent forgets to stop them often enough that waiting on
//   one would hold the notification forever. A job that wakes the agent later starts a new turn,
//   and that turn notifies again under the same tag, which replaces the earlier notification.
// - Only sessions a Bot holds on the canvas, and Father sessions. This machine runs many sessions
//   nobody curated (probes, workers, the security-review plugin's), and they would bury these.

import type { BotRecord } from "@agentdesk/agent-feed-wire";
import type { PushPayload } from "@/push/pushSender";
import type { Session } from "@/transcripts/transcriptTypes";

export type TurnFinishedSources = {
  /** The catalog: every session, on every change. Returns the unsubscribe. */
  subscribe: (listener: (sessions: readonly Session[]) => void) => () => void;
  bots: () => Promise<readonly BotRecord[]>;
  push: (payload: PushPayload) => Promise<void>;
  /** Whether this process is the one that sends (`pushSenderLease.ts`). */
  mayPush: () => boolean;
  /** Runs `work` after `ms` unless the returned cancel runs first. `work` settles when its push has. */
  schedule: (work: () => Promise<void>, ms: number) => () => void;
  quietMs: number;
};

const BODY_LIMIT = 140;

function sessionKey(session: Pick<Session, "source" | "sessionId">): string {
  return `${session.source}:${session.sessionId}`;
}

/** The Bot that holds this session on the canvas, or as its Father; null when none does. */
export function curatingBot(bots: readonly BotRecord[], key: string): BotRecord | null {
  for (const bot of bots) {
    if (bot.fatherSession && sessionKey(bot.fatherSession) === key) return bot;
    if (bot.offCanvas) continue;
    if ((bot.offCanvasSessionRefs ?? []).some((ref) => sessionKey(ref) === key)) continue;
    if (bot.sessionRefs.some((ref) => sessionKey(ref) === key)) return bot;
  }
  return null;
}

export function turnFinishedPayload(bot: BotRecord, session: Session): PushPayload {
  const label = (session.title ?? session.firstPrompt ?? "").replace(/\s+/g, " ").trim();
  const body = label ? `Finished: ${label}` : "Finished its turn";
  return {
    title: bot.name,
    body: body.length > BODY_LIMIT ? `${body.slice(0, BODY_LIMIT - 1)}…` : body,
    url: "/?entry=feed&view=canvas",
    tag: `turn:${sessionKey(session)}`,
  };
}

export function startTurnFinishedNotifier(sources: TurnFinishedSources): () => void {
  let closed: Map<string, boolean> | null = null;
  let latest = new Map<string, Session>();
  const waiting = new Map<string, () => void>();

  const send = async (key: string): Promise<void> => {
    const session = latest.get(key);
    if (!session || closed?.get(key) !== true || !sources.mayPush()) return;
    const bot = curatingBot(await sources.bots(), key);
    if (!bot) return;
    await sources.push(turnFinishedPayload(bot, session));
  };

  const unsubscribe = sources.subscribe((sessions) => {
    const before = closed;
    const now = new Map<string, boolean>();
    latest = new Map();
    for (const session of sessions) {
      if (session.source !== "claude") continue;
      const key = sessionKey(session);
      latest.set(key, session);
      // A tail that says nothing about the turn keeps what was known.
      const state = session.lastTurnClosed ?? before?.get(key);
      if (state === undefined) continue;
      now.set(key, state);
      if (!before) continue;
      if (!state) {
        waiting.get(key)?.();
        waiting.delete(key);
        continue;
      }
      if (before.get(key) !== false || waiting.has(key)) continue;
      waiting.set(
        key,
        sources.schedule(() => {
          waiting.delete(key);
          return send(key).catch((error: unknown) => {
            console.error(`[push] turn-finished push for ${key} failed`, error);
          });
        }, sources.quietMs),
      );
    }
    closed = now;
  });

  return () => {
    unsubscribe();
    for (const cancel of waiting.values()) cancel();
    waiting.clear();
  };
}
