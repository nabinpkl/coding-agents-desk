import { describe, expect, test } from "bun:test";
import type { BotRecord } from "@agentdesk/agent-feed-wire";
import type { PushPayload } from "@/push/pushSender";
import type { ReminderStore, StoredReminder } from "@/push/speechReminders";
import { drained } from "@/testing/until";
import {
  curatingBot,
  questionPayload,
  startTurnFinishedNotifier,
  turnFinishedPayload,
} from "@/push/turnFinishedNotifier";
import type { Session } from "@/transcripts/transcriptTypes";

function bot(fields: Partial<BotRecord> & Pick<BotRecord, "name" | "sessionRefs">): BotRecord {
  return { botId: fields.name, ...fields } as BotRecord;
}

function session(sessionId: string, lastTurnClosed: boolean | undefined, fields: Partial<Session> = {}): Session {
  return { sessionId, source: "claude", project: "/p", lastEventAt: 0, lastTurnClosed, ...fields };
}

const ALPHA = bot({ name: "Alpha", sessionRefs: [{ source: "claude", sessionId: "s1" }] });

const NOW = 1_000_000;

function harness(bots: readonly BotRecord[] = [ALPHA], mayPush = true, saved: StoredReminder[] = []) {
  let listener: (sessions: readonly Session[]) => void = () => {};
  const timers: { work: () => Promise<void>; ms: number; cancelled: boolean }[] = [];
  /** The reminder store, in memory: what a restart would read back. */
  const stored = [...saved];
  const reminderStore: ReminderStore = {
    load: () => Promise.resolve([...saved]),
    save: (reminder) => {
      stored.splice(0, stored.length, ...stored.filter((item) => item.key !== reminder.key), reminder);
      return Promise.resolve();
    },
    remove: (key, at) => {
      stored.splice(0, stored.length, ...stored.filter((item) => item.key !== key || item.at !== at));
      return Promise.resolve();
    },
  };
  const pushed: PushPayload[] = [];
  const announced: string[] = [];
  const stop = startTurnFinishedNotifier({
    subscribe: (next) => {
      listener = next;
      return () => {};
    },
    bots: () => Promise.resolve(bots),
    push: (payload) => {
      pushed.push(payload);
      return Promise.resolve();
    },
    announce: (curator, finished, occasion) => {
      announced.push(`${curator.name}:${finished.sessionId}:${occasion}`);
      return Promise.resolve();
    },
    mayPush: () => mayPush,
    schedule: (work, ms) => {
      const timer = { work, ms, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    quietMs: 10_000,
    questionQuietMs: 3_000,
    remindMs: 600_000,
    reminderStore,
    now: () => NOW,
  });
  const emit = (...sessions: Session[]) => listener(sessions);
  /** Runs every timer still standing, as if the quiet window passed. */
  const elapse = async () => {
    const standing = timers.splice(0).filter((timer) => !timer.cancelled);
    await Promise.all(standing.map((timer) => timer.work()));
  };

  return { emit, elapse, pushed, announced, timers, stored, stop };
}

describe("turn-finished notifier", () => {
  test("the first snapshot is only a baseline: a restart announces nothing", async () => {
    const { emit, elapse, pushed, timers } = harness();
    emit(session("s1", true));
    await elapse();
    expect(timers).toHaveLength(0);
    expect(pushed).toEqual([]);
  });

  test("an open turn that closes pushes once, after the quiet window", async () => {
    const { emit, elapse, pushed, timers } = harness();
    emit(session("s1", false));
    emit(session("s1", true, { title: "Fix the scroll", lastEventAt: 42 }));
    emit(session("s1", true, { title: "Fix the scroll", lastEventAt: 42 }));
    expect(timers).toHaveLength(1);
    expect(pushed).toEqual([]);
    await elapse();
    expect(pushed).toEqual([
      {
        title: "Alpha · Fix the scroll",
        body: "Finished its turn",
        url: "/?entry=feed&view=canvas",
        tag: "turn:claude:s1:42",
      },
    ]);
  });

  test("the same close is said on the audio channel at once, without the quiet window, by its Bot", async () => {
    const { emit, elapse, announced, pushed } = harness();
    emit(session("s1", false));
    emit(session("s1", true));
    await drained();
    expect(announced).toEqual(["Alpha:s1:finished"]);
    expect(pushed).toEqual([]);
    await elapse();
    expect(announced).toEqual(["Alpha:s1:finished"]);
    expect(pushed).toHaveLength(1);
  });

  test("a close whose reply ends with next suggestions pushes at once, with no window to wait out", async () => {
    const { emit, pushed, timers } = harness();
    const status = {
      from: "block" as const,
      at: 7,
      final: true as const,
      lines: [{ kind: "done" as const, text: "shipped" }],
    };
    emit(session("s1", false));
    emit(session("s1", true, { spokenStatus: status }));
    await drained();
    expect(pushed.map((payload) => payload.body)).toEqual(["Done: shipped"]);
    expect(timers).toHaveLength(0);
  });

  test("a turn that reopens inside the window is said but not pushed", async () => {
    const { emit, elapse, announced, pushed } = harness();
    emit(session("s1", false));
    emit(session("s1", true));
    emit(session("s1", false));
    await elapse();
    expect(announced).toEqual(["Alpha:s1:finished"]);
    expect(pushed).toEqual([]);
  });

  test("a turn that closed with a status pushes its first line, and a waiting one is said once more", async () => {
    const { emit, elapse, pushed, announced, timers, stored } = harness();
    const status = { from: "block" as const, at: 7, lines: [{ kind: "waiting" as const, text: "say go to rebuild" }] };
    emit(session("s1", false));
    emit(session("s1", true, { spokenStatus: status }));
    await elapse();
    expect(pushed[0]?.body).toBe("Needs you: say go to rebuild");
    expect(timers.filter((timer) => !timer.cancelled)).toHaveLength(1);
    // Kept, so a restart before it is due still owes it.
    expect(stored).toEqual([{ key: "claude:s1", at: 7, due: NOW + 600_000 }]);
    await elapse();
    expect(announced).toEqual(["Alpha:s1:finished", "Alpha:s1:reminder"]);
    // Once only: nothing stands after the reminder, in memory or in the store.
    expect(timers.filter((timer) => !timer.cancelled)).toHaveLength(0);
    expect(stored).toEqual([]);
  });

  test("a reminder a restart reads back is armed for the time it has left, and said", async () => {
    const status = { from: "block" as const, at: 7, lines: [{ kind: "waiting" as const, text: "pick one" }] };
    const { emit, elapse, announced, timers, stored } = harness([ALPHA], true, [
      { key: "claude:s1", at: 7, due: NOW + 90_000 },
    ]);
    emit(session("s1", true, { spokenStatus: status }));
    await drained();
    expect(timers.map((timer) => timer.ms)).toEqual([90_000]);
    await elapse();
    expect(announced).toEqual(["Alpha:s1:reminder"]);
    expect(stored).toEqual([]);
  });

  test("a read-back reminder already past due fires at once, and says nothing if its wait ended", async () => {
    const newer = { from: "block" as const, at: 8, lines: [{ kind: "done" as const, text: "rebuilt" }] };
    const { emit, elapse, announced, timers, stored } = harness([ALPHA], true, [
      { key: "claude:s1", at: 7, due: NOW - 5_000 },
    ]);
    emit(session("s1", true, { spokenStatus: newer }));
    await drained();
    expect(timers.map((timer) => timer.ms)).toEqual([0]);
    await elapse();
    expect(announced).toEqual([]);
    expect(stored).toEqual([]);
  });

  test("a sidecar that does not send leaves a read-back reminder for the one that does", async () => {
    const status = { from: "block" as const, at: 7, lines: [{ kind: "waiting" as const, text: "pick one" }] };
    const saved = [{ key: "claude:s1", at: 7, due: NOW + 1_000 }];
    const { emit, elapse, announced, stored } = harness([ALPHA], false, saved);
    emit(session("s1", true, { spokenStatus: status }));
    await drained();
    await elapse();
    expect(announced).toEqual([]);
    expect(stored).toEqual(saved);
  });

  test("a reminder is not said once the person has started a new turn", async () => {
    const { emit, elapse, announced } = harness();
    const status = { from: "block" as const, at: 7, lines: [{ kind: "waiting" as const, text: "pick one" }] };
    emit(session("s1", false));
    emit(session("s1", true, { spokenStatus: status }));
    await elapse();
    emit(session("s1", false));
    await elapse();
    expect(announced).toEqual(["Alpha:s1:finished"]);
  });

  test("a question it waits on is pushed and said once, after its quiet window", async () => {
    const { emit, elapse, pushed, announced } = harness();
    const question = { from: "question" as const, at: 9, lines: [{ kind: "waiting" as const, text: "Rebuild now?" }] };
    emit(session("s1", false));
    emit(session("s1", false, { spokenStatus: question }));
    emit(session("s1", false, { spokenStatus: question }));
    await elapse();
    expect(pushed.map((payload) => payload.body)).toEqual(["Asks: Rebuild now?"]);
    expect(announced).toEqual(["Alpha:s1:question"]);
  });

  test("a question answered inside its window, or already open at startup, is not announced", async () => {
    const answered = harness();
    const question = { from: "question" as const, at: 9, lines: [{ kind: "waiting" as const, text: "Rebuild now?" }] };
    answered.emit(session("s1", false));
    answered.emit(session("s1", false, { spokenStatus: question }));
    answered.emit(session("s1", false));
    await answered.elapse();
    expect(answered.announced).toEqual([]);
    const restarted = harness();
    restarted.emit(session("s1", false, { spokenStatus: question }));
    await restarted.elapse();
    expect(restarted.announced).toEqual([]);
  });

  test("a turn that opens again inside the window pushes nothing", async () => {
    const { emit, elapse, pushed } = harness();
    emit(session("s1", false));
    emit(session("s1", true));
    emit(session("s1", false));
    await elapse();
    expect(pushed).toEqual([]);
  });

  test("a session first seen already closed was discovered, not finished", async () => {
    const { emit, elapse, pushed } = harness();
    emit(session("other", false));
    emit(session("other", false), session("s1", true));
    await elapse();
    expect(pushed).toEqual([]);
  });

  test("a tail that says nothing about the turn keeps the state it had", async () => {
    const { emit, elapse, pushed } = harness();
    emit(session("s1", false));
    emit(session("s1", undefined));
    emit(session("s1", true));
    await elapse();
    expect(pushed).toHaveLength(1);
  });

  test("each turn of one session gets its own tag, so the second does not replace the first", async () => {
    const { emit, elapse, pushed } = harness();
    emit(session("s1", false));
    emit(session("s1", true, { lastEventAt: 1 }));
    await elapse();
    emit(session("s1", false, { lastEventAt: 2 }));
    emit(session("s1", true, { lastEventAt: 3 }));
    await elapse();
    expect(pushed.map((payload) => payload.tag)).toEqual(["turn:claude:s1:1", "turn:claude:s1:3"]);
  });

  test("only Claude sessions a Bot holds on the canvas push", async () => {
    const bots = [
      bot({ name: "Off", offCanvas: true, sessionRefs: [{ source: "claude", sessionId: "s2" }] }),
      bot({
        name: "Partly",
        sessionRefs: [
          { source: "claude", sessionId: "s3" },
          { source: "claude", sessionId: "s4" },
        ],
        offCanvasSessionRefs: [{ source: "claude", sessionId: "s4" }],
      }),
    ];
    const { emit, elapse, pushed } = harness(bots);
    const ids = ["s2", "s3", "s4", "loose"];
    emit(...ids.map((id) => session(id, false)), session("op", false, { source: "opencode" }));
    emit(...ids.map((id) => session(id, true)), session("op", true, { source: "opencode" }));
    await elapse();
    expect(pushed.map((payload) => payload.tag)).toEqual(["turn:claude:s3:0"]);
  });

  test("a process that does not hold the sender lease pushes nothing", async () => {
    const { emit, elapse, pushed } = harness([ALPHA], false);
    emit(session("s1", false));
    emit(session("s1", true));
    await elapse();
    expect(pushed).toEqual([]);
  });

  test("stopping cancels a push still waiting out its window", async () => {
    const { emit, pushed, timers, stop } = harness();
    emit(session("s1", false));
    emit(session("s1", true));
    stop();
    expect(timers[0]?.cancelled).toBe(true);
    expect(pushed).toEqual([]);
  });
});

describe("curatingBot and the payload", () => {
  test("a Father session belongs to its Bot even off the canvas", () => {
    const father = bot({
      name: "Dad",
      offCanvas: true,
      sessionRefs: [],
      fatherSession: { source: "claude", sessionId: "f" },
    });
    expect(curatingBot([father], "claude:f")?.name).toBe("Dad");
  });

  test("the title names the session after its Bot, by its title, else its anchor", () => {
    const anchored = bot({ ...ALPHA, sessionAnchors: { "claude:s1": "Alan" } });
    const titled = session("s1", true, { title: " Alan (fix\nthe scroll) " });
    expect(turnFinishedPayload(anchored, titled).title).toBe("Alpha · Alan (fix the scroll)");
    expect(turnFinishedPayload(anchored, session("s1", true)).title).toBe("Alpha · Alan");
    expect(turnFinishedPayload(ALPHA, session("s1", true)).title).toBe("Alpha");
    const asking = session("s1", false, {
      title: "Alan (fix the scroll)",
      spokenStatus: { from: "question", at: 1, lines: [{ kind: "waiting", text: "Rebuild now?" }] },
    });
    expect(questionPayload(anchored, asking)).toMatchObject({
      title: "Alpha · Alan (fix the scroll)",
      body: "Asks: Rebuild now?",
    });
  });

  test("the body falls back to the first prompt of an untitled session, then to a plain line, and stays short", () => {
    expect(turnFinishedPayload(ALPHA, session("s1", true, { firstPrompt: "  look\nat this " })).body).toBe(
      "Finished: look at this",
    );
    // A titled session is named in the title already.
    expect(turnFinishedPayload(ALPHA, session("s1", true, { title: "Fix", firstPrompt: "look" })).body).toBe(
      "Finished its turn",
    );
    expect(turnFinishedPayload(ALPHA, session("s1", true)).body).toBe("Finished its turn");
    expect(turnFinishedPayload(ALPHA, session("s1", true, { firstPrompt: "x".repeat(300) })).body).toHaveLength(140);
  });
});
