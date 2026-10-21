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
//   and that turn notifies too.
// - Each turn has its own tag, the session's plus the time the turn closed. One session finishes
//   many tasks, and a notification that shares a tag with one still showing replaces it silently.
// - Only sessions a Bot holds on the canvas, and Father sessions. This machine runs many sessions
//   nobody curated (probes, workers, the security-review plugin's), and they would bury these.
//
// The same moment is also announced (`announce`): the session's spoken status said on the Mac's
// audio channel (`sessionSpeech.ts`). Each goes out whether or not the other one fails.
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
import type { Session } from "@/transcripts/transcriptTypes";

export type TurnFinishedSources = {
  /** The catalog: every session, on every change. Returns the unsubscribe. */
  subscribe: (listener: (sessions: readonly Session[]) => void) => () => void;
  bots: () => Promise<readonly BotRecord[]>;
  push: (payload: PushPayload) => Promise<void>;
  /** Says what the session has to say on `occasion` to whoever listens on the audio channel. */
  announce: (bot: BotRecord, session: Session, occasion: SpeechOccasion) => Promise<void>;
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

/** A status line as a notification shows it: the kind, then what the session wrote. */
function statusLineText(line: NonNullable<Session["spokenStatus"]>["lines"][number]): string {
  const kind = { waiting: "Needs you", failed: "Failed", done: "Done", running: "Running", note: "Note" }[line.kind];
  return `${kind}: ${line.text}`;
}

function bounded(body: string): string {
  return body.length > BODY_LIMIT ? `${body.slice(0, BODY_LIMIT - 1)}…` : body;
}

/** A finished turn: its first status line when it closed with a block, otherwise what it was about. */
export function turnFinishedPayload(bot: BotRecord, session: Session): PushPayload {
  const label = (session.title ?? session.firstPrompt ?? "").replace(/\s+/g, " ").trim();
  const first = session.spokenStatus?.from === "block" ? session.spokenStatus.lines[0] : undefined;
  const body = first ? statusLineText(first) : label ? `Finished: ${label}` : "Finished its turn";
  return {
    title: bot.name,
    body: bounded(body),
    url: "/?entry=feed&view=canvas",
    tag: `turn:${sessionKey(session)}:${session.lastEventAt}`,
  };
}

/** A question the session waits on. */
export function questionPayload(bot: BotRecord, session: Session): PushPayload {
  const asked = session.spokenStatus?.lines[0]?.text ?? "a question";
  return {
    title: bot.name,
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
    bot: BotRecord,
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
        const bot = curatingBot(await sources.bots(), key);
        if (bot) await deliver(key, bot, session, "reminder", null);
      },
      Math.max(0, due - sources.now()),
    );
    reminders.set(key, { at, cancel });
  };

  const send = async (key: string): Promise<void> => {
    const session = latest.get(key);
    if (!session || closed?.get(key) !== true || !sources.mayPush()) return;
    const bot = curatingBot(await sources.bots(), key);
    if (!bot) return;
    await deliver(key, bot, session, "finished", turnFinishedPayload(bot, session));
  };

  const sendQuestion = async (key: string, at: number): Promise<void> => {
    const session = latest.get(key);
    if (!session || session.spokenStatus?.from !== "question" || session.spokenStatus.at !== at || !sources.mayPush())
      return;
    const bot = curatingBot(await sources.bots(), key);
    if (!bot) return;
    await deliver(key, bot, session, "question", questionPayload(bot, session));
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
      if (session.source !== "claude") continue;
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
