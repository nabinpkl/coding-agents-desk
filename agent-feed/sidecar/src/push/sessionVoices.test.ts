import { describe, expect, test } from "bun:test";
import type { BotRecord } from "@agentdesk/agent-feed-wire";
import type { StoredBotSnapshot } from "@/bots/botStore";
import { createSessionVoices, VOICE_POOL, voiceFor, voicesHeld } from "@/push/sessionVoices";

function bot(botId: string, sessions: string[], fields: Partial<BotRecord> = {}): BotRecord {
  return {
    botId,
    name: botId,
    sessionRefs: sessions.map((sessionId) => ({ source: "claude", sessionId })),
    ...fields,
  } as BotRecord;
}

/** A Bot store in memory, whose `mutate` runs one write at a time as the real one does. */
function store(bots: BotRecord[]) {
  let snapshot = { version: 3, revision: 0, bots, idempotency: {} } as StoredBotSnapshot;
  let line = Promise.resolve();
  return {
    snapshot: () => Promise.resolve(snapshot),
    mutate<T>(mutation: (current: StoredBotSnapshot) => { snapshot: StoredBotSnapshot; value: T }): Promise<T> {
      const run = line.then(() => {
        const result = mutation(snapshot);
        snapshot = result.snapshot;
        return result.value;
      });
      line = run.then(() => undefined);
      return run;
    },
    current: () => snapshot,
  };
}

describe("a voice for each session a Bot holds", () => {
  test("the first session gets the pool's first voice, and keeps it", async () => {
    const bots = store([bot("a", ["s1"])]);
    const voices = createSessionVoices(bots);
    expect(await voices.voiceOf("a", "claude:s1")).toBe(VOICE_POOL[0]);
    const revision = bots.current().revision;
    expect(await voices.voiceOf("a", "claude:s1")).toBe(VOICE_POOL[0]);
    expect(bots.current().revision).toBe(revision);
  });

  test("two sessions announced at once never share a voice", async () => {
    const voices = createSessionVoices(store([bot("a", ["s1"]), bot("b", ["s2"])]));
    const given = await Promise.all([voices.voiceOf("a", "claude:s1"), voices.voiceOf("b", "claude:s2")]);
    expect(new Set(given).size).toBe(2);
  });

  test("a session off the canvas or out of its Bot frees its voice for the next one", () => {
    const off = bot("a", ["s1", "s2"], {
      sessionVoices: { "claude:s1": "Easton", "claude:gone": "Hadley" },
      offCanvasSessionRefs: [{ source: "claude", sessionId: "s1" }],
    });
    expect([...voicesHeld([off]).keys()]).toEqual([]);
    expect(voiceFor([off], "a", "claude:s2")).toEqual({ voice: "Easton", given: true });
  });

  test("one put back speaks as it did unless its voice went to another meanwhile", async () => {
    const back = bot("a", ["s1"], { sessionVoices: { "claude:s1": "Miles" } });
    expect(voiceFor([back], "a", "claude:s1")).toEqual({ voice: "Miles", given: false });
    // s1 left holding Easton, the first voice; s2 is announced and takes it.
    const bots = store([bot("a", ["s2"], { sessionVoices: { "claude:s1": "Easton" } })]);
    const voices = createSessionVoices(bots);
    expect(await voices.voiceOf("a", "claude:s2")).toBe("Easton");
    expect(bots.current().bots[0]?.sessionVoices).toEqual({ "claude:s2": "Easton" });
    // s1 is put back, and gets the next free voice rather than one s2 now speaks in.
    const both = store([
      {
        ...bots.current().bots[0]!,
        sessionRefs: [...bots.current().bots[0]!.sessionRefs, { source: "claude", sessionId: "s1" }],
      },
    ]);
    expect(await createSessionVoices(both).voiceOf("a", "claude:s1")).toBe("Hadley");
  });

  test("a voice given away is taken off the session that left it behind", async () => {
    const bots = store([bot("a", ["s1"], { sessionVoices: { "claude:left": "Easton" } }), bot("b", ["s2"])]);
    expect(await createSessionVoices(bots).voiceOf("b", "claude:s2")).toBe("Easton");
    expect(bots.current().bots[0]?.sessionVoices).toEqual({});
    expect(bots.current().bots[1]?.sessionVoices).toEqual({ "claude:s2": "Easton" });
  });

  test("with every voice held, a session speaks in the voice in use", () => {
    const full = bot(
      "a",
      VOICE_POOL.map((_, index) => `s${index}`),
      { sessionVoices: Object.fromEntries(VOICE_POOL.map((voice, index) => [`claude:s${index}`, voice])) },
    );
    expect(voiceFor([full, bot("b", ["late"])], "b", "claude:late")).toEqual({ voice: null, given: false });
  });
});

describe("the voices a Bot record keeps", () => {
  test("every voice in the pool is written and read back by the Bot store", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { BotStore } = await import("@/bots/botStore");
    const directory = await mkdtemp(join(tmpdir(), "session-voices-"));
    try {
      const path = join(directory, "bots.json");
      const sessions = VOICE_POOL.map((_, index) => `s${index}`);
      const record = {
        ...bot("a", sessions),
        environment: { kind: "directory", path: directory },
        metadata: { labels: [], custom: {} },
        grants: [],
        createdAt: 1,
        createdBy: { kind: "user" },
      } as BotRecord;
      await new BotStore(path).mutate((snapshot) => ({
        snapshot: { ...snapshot, revision: 1, bots: [record] },
        value: undefined,
      }));
      const voices = createSessionVoices(new BotStore(path));
      for (const session of sessions) await voices.voiceOf("a", `claude:${session}`);
      // A fresh store reads the file back whole: a voice it refused would lose every Bot in it.
      const read = await new BotStore(path).snapshot();
      expect(Object.values(read.bots[0]?.sessionVoices ?? {}).sort()).toEqual([...VOICE_POOL].sort());
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
