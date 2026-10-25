// A push when a session in a Bot finishes its turn, and the same moment said on the Mac's audio
// channel for every session.
//
// The signal is the catalog's, not a live connection's: the catalog keeps `lastTurnClosed` for each
// session all the time, from every Claude transcript (an assistant record ending on `end_turn` closes
// the turn, a user record opens it) and from the opencode serve's event stream (`opencodeCatalog`).
// The SDK client and the live sources connect only while a panel is looking, which is exactly when a
// notification is not needed.
//
// The rules, each for a reason:
// - The first catalog snapshot only records where every session stands. A restart (every save
//   under `bun --watch`) must not announce every turn that was already closed.
// - Only a session seen open and then closed notifies. A session first seen already closed was
//   discovered, not finished.
// - A close waits out a quiet window before it is pushed, and a turn that opens again inside it
//   pushes nothing: a queued prompt, an agent that carries straight on, a background job that wakes
//   it. Unless the reply closed with next suggestions (`final` on its status), which a session
//   writes only once it believes its work is done: that is pushed at once.
// - Background jobs are not tracked: an agent forgets to stop them often enough that waiting on
//   one would hold the notification forever. A job that wakes the agent later starts a new turn,
//   and that turn notifies too.
// - Each turn has its own tag, the session's plus the time the turn closed. One session finishes
//   many tasks, and a notification that shares a tag with one still showing replaces it silently.
// - Pushed only for sessions a Bot holds on the canvas, and Father sessions. This machine runs many
//   sessions nobody curated (probes, workers), and a phone buzzing for each would bury these.
//
// The same moment is also announced (`announce`): the session's spoken status said on the Mac's
// audio channel (`sessionSpeech.ts`), at once rather than after the window, because a listener is
// there to hear the turn end as it ends, and a turn that carries on simply says something more.
// Each goes out whether or not the other one fails. Announced for every session heard from
// (`heardFrom`), on the owner's word (2026-10-24): a session outside any Bot is announced as itself,
// in the voice in use, where a Bot's session has a voice of its own (`sessionVoices.ts`). Only the
// security reviewer's sessions are never heard.
//
// Two more moments, for the same sessions:
// - A question the session asks through a tool and waits on (its spoken status turns `question`).
//   Pushed and said once, after a short quiet window; the first snapshot only records the ones
//   already open, as for turns.
// - A wait that goes on. A status that needs the person, from a finished turn or a question, is said
//   once more after `remindMs` if it is still the session's status then, and never again after that.
//   The reminder is kept in `reminderStore` too, so a restart arms it again for the time it has left.

import type { BotRecord } from "@agentdesk/agent-feed-wire";
import type { PushPayload } from "@/push/pushSender";
import type { SpeechOccasion } from "@/push/sessionSpeech";
import type { ReminderStore } from "@/push/speechReminders";
import { sessionAutomation } from "@/transcripts/catalog/sessionAutomation";
import type { Session } from "@/transcripts/transcriptTypes";

export type TurnFinishedSources = {
  /** The catalog: every session, on every change. Returns the unsubscribe. */
  subscribe: (listener: (sessions: readonly Session[]) => void) => () => void;
  bots: () => Promise<readonly BotRecord[]>;
  push: (payload: PushPayload) => Promise<void>;
  /**
   * Says what the session has to say on `occasion` to whoever listens on the audio channel, as the
   * Bot that holds it on the canvas, or as itself when none does (`bot` null).
   */
  announce: (bot: BotRecord | null, session: Session, occasion: SpeechOccasion) => Promise<void>;
  /** Whether this process is the one that sends (`pushSenderLease.ts`). */
  mayPush: () => boolean;
  /** Runs `work` after `ms` unless the returned cancel runs first. `work` settles when its push has. */
  schedule: (work: () => Promise<void>, ms: number) => () => void;
  quietMs: number;
  /** How long a question stands before it is announced: one answered at once needs no word. */
  questionQuietMs: number;
  /** How long a status that needs the person stands before it is said once more. */
  remindMs: number;
  /** Where reminders outlive this process (`speechReminders.ts`). */
  reminderStore: ReminderStore;
  now: () => number;
};

const BODY_LIMIT = 140;

/** How recently a session first listed already closed must have moved to count as having finished. */
const FIRST_TURN_WINDOW_MS = 60_000;

function sessionKey(session: Pick<Session, "source" | "sessionId">): string {
  return `${session.source}:${session.sessionId}`;
}

/** The sessions a Bot holds on the canvas, and its Father session: the ones heard as this Bot's. */
export function curatedKeys(bot: BotRecord): Set<string> {
  const keys = new Set<string>();
  if (bot.fatherSession) keys.add(sessionKey(bot.fatherSession));
  if (bot.offCanvas) return keys;
  const off = new Set((bot.offCanvasSessionRefs ?? []).map(sessionKey));
  for (const ref of bot.sessionRefs) if (!off.has(sessionKey(ref))) keys.add(sessionKey(ref));
  return keys;
}

/** The Bot that holds this session on the canvas, or as its Father; null when none does. */
export function curatingBot(bots: readonly BotRecord[], key: string): BotRecord | null {
  return bots.find((bot) => curatedKeys(bot).has(key)) ?? null;
}

/**
 * Whether a session is heard from at all: every Claude and opencode session but the ones a tool
 * starts on its own. The security reviewer is most of this machine's sessions (`sessionAutomation`),
 * and a review of every commit announced would bury what a person is waiting to hear.
 */
export function heardFrom(session: Session): boolean {
  return (session.source === "claude" || session.source === "opencode") && sessionAutomation(session) === undefined;
}

/** A status line as a notification shows it: the kind, then what the session wrote. */
function statusLineText(line: NonNullable<Session["spokenStatus"]>["lines"][number]): string {
  const kind = { waiting: "Needs you", failed: "Failed", done: "Done", running: "Running", note: "Note" }[line.kind];
  return `${kind}: ${line.text}`;
}

function bounded(body: string): string {
  return body.length > BODY_LIMIT ? `${body.slice(0, BODY_LIMIT - 1)}…` : body;
}

function oneLine(text: string | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

/**
 * Who a notification is from: the Bot, then the session as its card names it (its title, else its
 * anchor), since one Bot can hold dozens of sessions. The spoken form is `speakerName`.
 */
function notificationTitle(bot: Pick<BotRecord, "name" | "sessionAnchors">, session: Session): string {
  const name = oneLine(session.title) || oneLine(bot.sessionAnchors?.[sessionKey(session)]);
  return name ? `${bot.name} · ${name}` : bot.name;
}

/**
 * A finished turn: its first status line when it closed with a block. Otherwise its first prompt,
 * when it has no title to be named by yet, or a plain line: the title already says what it is.
 */
export function turnFinishedPayload(bot: BotRecord, session: Session): PushPayload {
  const prompt = oneLine(session.title) ? "" : oneLine(session.firstPrompt);
  const first = session.spokenStatus?.from === "block" ? session.spokenStatus.lines[0] : undefined;
  const body = first ? statusLineText(first) : prompt ? `Finished: ${prompt}` : "Finished its turn";
  return {
    title: notificationTitle(bot, session),
    body: bounded(body),
    url: "/?entry=feed&view=canvas",
    tag: `turn:${sessionKey(session)}:${session.lastEventAt}`,
  };
}

/** A question the session waits on. */
export function questionPayload(bot: BotRecord, session: Session): PushPayload {
  const asked = session.spokenStatus?.lines[0]?.text ?? "a question";
  return {
    title: notificationTitle(bot, session),
    body: bounded(`Asks: ${asked}`),
    url: "/?entry=feed&view=canvas",
    tag: `question:${sessionKey(session)}:${session.spokenStatus?.at ?? 0}`,
  };
}

/** Whether a status asks something of the person. */
function needsPerson(status: Session["spokenStatus"]): boolean {
  return status?.lines.some((line) => line.kind === "waiting") ?? false;
}

export function startTurnFinishedNotifier(sources: TurnFinishedSources): () => void {
  let closed: Map<string, boolean> | null = null;
  let latest = new Map<string, Session>();
  const waiting = new Map<string, () => void>();
  /** The question each session was last heard asking, by when it asked: each is announced once. */
  const asked = new Map<string, number>();
  const questions = new Map<string, () => void>();
  /** The one reminder standing for each session, and the status it is about. */
  const reminders = new Map<string, { at: number; cancel: () => void }>();

  /** Pushes and says, each whether or not the other fails; the push's failure is the one thrown. */
  const deliver = async (
    key: string,
    bot: BotRecord | null,
    session: Session,
    occasion: SpeechOccasion,
    payload: PushPayload | null,
  ) => {
    const [pushed, announced] = await Promise.allSettled([
      payload ? sources.push(payload) : Promise.resolve(),
      sources.announce(bot, session, occasion),
    ]);
    if (announced.status === "rejected")
      console.error(`[speech] ${occasion} speech for ${key} failed`, announced.reason);
    if (needsPerson(session.spokenStatus) && occasion !== "reminder") remindLater(key, session.spokenStatus?.at ?? 0);
    if (pushed.status === "rejected") throw pushed.reason;
  };

  /** Keeps the store in step; a failed write costs only a reminder after a restart, so it is logged. */
  const stored = (write: Promise<void>, what: string) =>
    void write.catch((error: unknown) => console.error(`[speech] could not ${what}`, error));

  /** Arms the session's one reminder, due at `due`: a new one, or one a restart read back (`restored`). */
  const remindLater = (key: string, at: number, due = sources.now() + sources.remindMs, restored = false) => {
    if (reminders.get(key)?.at === at) return;
    // Read back after a newer one was set: the newer one is the wait that stands.
    if (restored && reminders.has(key)) return;
    reminders.get(key)?.cancel();
    if (!restored) stored(sources.reminderStore.save({ key, at, due }), `keep the reminder for ${key}`);
    const cancel = sources.schedule(
      async () => {
        reminders.delete(key);
        // Only the sender clears it: a sidecar beside it that read the same file back says nothing,
        // and the sender, restarted later, still owes it.
        if (sources.mayPush()) stored(sources.reminderStore.remove(key, at), `clear the reminder for ${key}`);
        const session = latest.get(key);
        const status = session?.spokenStatus;
        // Only the same wait, still standing: a new turn, an answer or a newer status ended it.
        if (!session || status?.at !== at || !needsPerson(status) || !sources.mayPush()) return;
        if (status.from === "block" && closed?.get(key) !== true) return;
        await deliver(key, curatingBot(await sources.bots(), key), session, "reminder", null);
      },
      Math.max(0, due - sources.now()),
    );
    reminders.set(key, { at, cancel });
  };

  /** Says a turn that has just closed, and arms its reminder when it waits on the person. */
  const announceFinished = async (key: string, session: Session): Promise<void> => {
    if (!sources.mayPush()) return;
    const bot = curatingBot(await sources.bots(), key);
    try {
      await sources.announce(bot, session, "finished");
    } catch (error) {
      console.error(`[speech] finished speech for ${key} failed`, error);
    }
    if (needsPerson(session.spokenStatus)) remindLater(key, session.spokenStatus?.at ?? 0);
  };

  const pushFinished = async (key: string, session: Session): Promise<void> => {
    if (!sources.mayPush()) return;
    const bot = curatingBot(await sources.bots(), key);
    if (bot) await sources.push(turnFinishedPayload(bot, session));
  };

  /** The push after the quiet window: only if the turn is still closed, as it was then. */
  const send = async (key: string): Promise<void> => {
    const session = latest.get(key);
    if (!session || closed?.get(key) !== true) return;
    await pushFinished(key, session);
  };

  const sendQuestion = async (key: string, at: number): Promise<void> => {
    const session = latest.get(key);
    if (!session || session.spokenStatus?.from !== "question" || session.spokenStatus.at !== at || !sources.mayPush())
      return;
    const bot = curatingBot(await sources.bots(), key);
    await deliver(key, bot, session, "question", bot ? questionPayload(bot, session) : null);
  };

  /** Announces a question once it has stood for the quiet window, unless it was answered first. */
  const watchQuestion = (key: string, session: Session, baseline: boolean) => {
    const status = session.spokenStatus;
    if (status?.from !== "question") {
      questions.get(key)?.();
      questions.delete(key);
      return;
    }
    if (asked.get(key) === status.at) return;
    asked.set(key, status.at);
    if (baseline) return;
    questions.get(key)?.();
    questions.set(
      key,
      sources.schedule(() => {
        questions.delete(key);
        return sendQuestion(key, status.at).catch((error: unknown) => {
          console.error(`[push] question push for ${key} failed`, error);
        });
      }, sources.questionQuietMs),
    );
  };

  const unsubscribe = sources.subscribe((sessions) => {
    const before = closed;
    const now = new Map<string, boolean>();
    latest = new Map();
    for (const session of sessions) {
      if (!heardFrom(session)) continue;
      const key = sessionKey(session);
      latest.set(key, session);
      watchQuestion(key, session, !before);
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
      // A session new since the last snapshot whose turn has just closed finished it: a fresh chat
      // can open and close its first turn before the catalog first lists it. One that last moved
      // longer ago than that was discovered, not finished.
      const firstTurnJustClosed = !before.has(key) && sources.now() - session.lastEventAt < FIRST_TURN_WINDOW_MS;
      if ((before.get(key) !== false && !firstTurnJustClosed) || waiting.has(key)) continue;
      void announceFinished(key, session).catch((error: unknown) => {
        console.error(`[speech] finished speech for ${key} failed`, error);
      });
      if (session.spokenStatus?.final) {
        void pushFinished(key, session).catch((error: unknown) => {
          console.error(`[push] turn-finished push for ${key} failed`, error);
        });
        continue;
      }
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

  // What a previous run left standing, armed for the time it has left (at once if that has passed).
  // After the first snapshot, so a reminder that fires at once finds the sessions it asks about.
  let stopped = false;
  void sources.reminderStore
    .load()
    .then((saved) => {
      for (const { key, at, due } of saved) if (!stopped) remindLater(key, at, due, true);
    })
    .catch((error: unknown) => console.error("[speech] could not read the saved reminders", error));

  return () => {
    stopped = true;
    unsubscribe();
    for (const cancel of waiting.values()) cancel();
    waiting.clear();
    for (const cancel of questions.values()) cancel();
    questions.clear();
    // Cancelled, not cleared from the store: stopping is this process going, and the next one owes them.
    for (const { cancel } of reminders.values()) cancel();
    reminders.clear();
  };
}
