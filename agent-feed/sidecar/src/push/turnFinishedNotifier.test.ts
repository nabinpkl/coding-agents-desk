import { describe, expect, test } from "bun:test";
import type { BotRecord } from "@agentdesk/agent-feed-wire";
import type { PushPayload } from "@/push/pushSender";
import { curatingBot, startTurnFinishedNotifier, turnFinishedPayload } from "@/push/turnFinishedNotifier";
import type { Session } from "@/transcripts/transcriptTypes";

function bot(fields: Partial<BotRecord> & Pick<BotRecord, "name" | "sessionRefs">): BotRecord {
  return { botId: fields.name, ...fields } as BotRecord;
}

function session(sessionId: string, lastTurnClosed: boolean | undefined, fields: Partial<Session> = {}): Session {
  return { sessionId, source: "claude", project: "/p", lastEventAt: 0, lastTurnClosed, ...fields };
}

const ALPHA = bot({ name: "Alpha", sessionRefs: [{ source: "claude", sessionId: "s1" }] });

function harness(bots: readonly BotRecord[] = [ALPHA], mayPush = true) {
  let listener: (sessions: readonly Session[]) => void = () => {};
  const timers: { work: () => Promise<void>; cancelled: boolean }[] = [];
  const pushed: PushPayload[] = [];
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
    mayPush: () => mayPush,
    schedule: (work) => {
      const timer = { work, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    quietMs: 10_000,
  });
  const emit = (...sessions: Session[]) => listener(sessions);
  /** Runs every timer still standing, as if the quiet window passed. */
  const elapse = async () => {
    const standing = timers.splice(0).filter((timer) => !timer.cancelled);
    await Promise.all(standing.map((timer) => timer.work()));
  };

  return { emit, elapse, pushed, timers, stop };
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
    emit(session("s1", true, { title: "Fix the scroll" }));
    emit(session("s1", true, { title: "Fix the scroll" }));
    expect(timers).toHaveLength(1);
    expect(pushed).toEqual([]);
    await elapse();
    expect(pushed).toEqual([
      { title: "Alpha", body: "Finished: Fix the scroll", url: "/?entry=feed&view=canvas", tag: "turn:claude:s1" },
    ]);
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
    expect(pushed.map((payload) => payload.tag)).toEqual(["turn:claude:s3"]);
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

  test("the body falls back to the first prompt, then to a plain line, and stays short", () => {
    expect(turnFinishedPayload(ALPHA, session("s1", true, { firstPrompt: "  look\nat this " })).body).toBe(
      "Finished: look at this",
    );
    expect(turnFinishedPayload(ALPHA, session("s1", true)).body).toBe("Finished its turn");
    expect(turnFinishedPayload(ALPHA, session("s1", true, { title: "x".repeat(300) })).body).toHaveLength(140);
  });
});
