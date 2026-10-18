// What a registry subscriber is woken for. The distinction is the whole point: session churn is
// frequent and means nothing to a Bot, and a subscriber that cannot tell them apart republishes on
// every one. On the hub that was over a hundred whole-directory writes a minute.
//
// Which is the HUB's question. There are two, because a Bot's view is the store's records AND the
// catalog's answers about them, and a catalog event that moves no Bot can still change what a
// subscriber DRAWS: a reference that stopped resolving became a `missing` row, and one that started
// resolving stops being one. Measured 2026-09-26: a panel was handed a snapshot taken while the
// catalog was half-reconciled after a restart, in which every Claude reference read as `missing`;
// the registry recomputed it correctly 7ms later, logged that it had, and the store's revision check
// dropped the correction. The panel kept those rows -- and the layout they took up -- until the
// reader touched a Bot themselves, because that was the only thing that moved the revision.
import { expect, test } from "bun:test";
import { botRegistryHarness } from "@/bots/botRegistryHarness";

const { addBot, addSessions, fixture, notifyCatalog, sessions, startingCatalog, summary } = botRegistryHarness();

/** The emit is queued on a promise chain and reads the store, so it lands a tick or two later. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10));

async function aBotWithASession() {
  const world = await fixture();
  const bot = await addBot(
    world.registry,
    {
      requestId: "r1",
      name: "Release Captain",
      directoryPath: world.project,
      metadata: { role: "x", labels: ["release"], custom: {} },
      grants: ["add_bot"],
    },
    { kind: "user" },
  );
  return { ...world, bot };
}

test("a subscriber is woken once for the current state, and not again for session churn", async () => {
  const { registry, bot } = await aBotWithASession();
  await addSessions(
    registry,
    bot.botId,
    { requestId: "r2", sessionRefs: [{ source: "pi", sessionId: "session-1" }] },
    { kind: "user" },
  );

  const seen: number[] = [];
  const stop = await registry.subscribe((snapshot) => seen.push(snapshot.revision));
  expect(seen).toHaveLength(1);

  // The catalog moves constantly and no Bot changed: a session's state, its token count, its last
  // activity. None of that changes the Bot list, so a subscriber has nothing to do about it.
  for (let i = 0; i < 25; i += 1) notifyCatalog();
  await settle();
  expect(seen).toHaveLength(1);
  stop();
});

test("a real change still gets through, because every one of them bumps the revision", async () => {
  const { registry, bot, project } = await aBotWithASession();
  const seen: number[] = [];
  const stop = await registry.subscribe((snapshot) => seen.push(snapshot.revision));
  const before = seen.length;

  // Attaching a session changes what the hub would publish for this Bot: its sessionIds.
  await addSessions(
    registry,
    bot.botId,
    { requestId: "r2", sessionRefs: [{ source: "pi", sessionId: "session-1" }] },
    { kind: "user" },
  );
  await settle();
  expect(seen.length).toBe(before + 1);
  expect(seen.at(-1)).toBeGreaterThan(seen[before - 1]!);

  // And a session that changes nothing about the Bot does not, even though it is the same session
  // doing the changing.
  notifyCatalog();
  await settle();
  expect(seen).toHaveLength(before + 1);
  stop();
  expect(project).toBeTruthy();
});

test("a second Bot appears exactly once, not once per subscriber-visible event", async () => {
  const world = await fixture();
  const seen: number[] = [];
  const stop = await world.registry.subscribe((snapshot) => seen.push(snapshot.revision));

  await addBot(
    world.registry,
    {
      requestId: "r1",
      name: "Second",
      directoryPath: world.secondProject,
      metadata: { role: "y", labels: ["ops"], custom: {} },
      grants: ["add_bot"],
    },
    { kind: "user" },
  );
  await settle();
  expect(seen).toHaveLength(2);

  // Churn afterwards, including on a session that exists in the catalog from the start.
  notifyCatalog();
  await settle();
  expect(seen).toHaveLength(2);
  stop();
});

test("unsubscribed means unsubscribed, so a stopped publisher stops being woken", async () => {
  const { registry, bot } = await aBotWithASession();
  const seen: number[] = [];
  const stop = await registry.subscribe((snapshot) => seen.push(snapshot.revision));
  stop();
  await addSessions(
    registry,
    bot.botId,
    { requestId: "r2", sessionRefs: [{ source: "pi", sessionId: "session-1" }] },
    { kind: "user" },
  );
  notifyCatalog();
  await settle();
  expect(seen).toHaveLength(1);
  expect(summary).toBeTruthy();
});

/** A Bot holding one reference the catalog can currently resolve. */
async function aBotHoldingAResolvableReference() {
  const world = await aBotWithASession();
  await addSessions(
    world.registry,
    world.bot.botId,
    { requestId: "r2", sessionRefs: [{ source: "pi", sessionId: "session-1" }] },
    { kind: "user" },
  );
  return world;
}

// A restart, played out: the sidecar is answering and its catalog has not been read. Before, the
// stream's first answer resolved against that and said every session on every Bot was missing, so
// every canvas closed every card and reopened them a moment later with nothing they had held.
test("nothing is said about a Bot until the catalog has been read, and then it is whole", async () => {
  const { registry } = await aBotHoldingAResolvableReference();
  const held = sessions.get("pi:session-1")!;
  sessions.delete("pi:session-1");
  const read = startingCatalog();

  const drawn: { sessions: number; missing: number }[] = [];
  const subscribed = registry.subscribe(
    (snapshot) =>
      drawn.push({
        sessions: snapshot.bots[0]!.sessions.length,
        missing: snapshot.bots[0]!.missingSessionRefs.length,
      }),
    undefined,
    { onChange: "view" },
  );
  const asked = registry.snapshot();
  notifyCatalog();
  await settle();
  expect(drawn).toEqual([]);

  sessions.set("pi:session-1", held);
  read();
  const stop = await subscribed;
  await settle();
  expect(drawn).toEqual([{ sessions: 1, missing: 0 }]);
  expect((await asked).bots[0]!.missingSessionRefs).toEqual([]);
  stop();
});

test("a subscriber drawing the view is told when a reference stops resolving", async () => {
  const { registry } = await aBotHoldingAResolvableReference();
  const drawn: number[][] = [];
  const stop = await registry.subscribe(
    (snapshot) => drawn.push(snapshot.bots.map((bot) => bot.missingSessionRefs.length)),
    undefined,
    { onChange: "view" },
  );
  expect(drawn.at(-1)).toEqual([0]);

  // The catalog forgetting a session, with nothing edited anywhere. No `mutate`, so the store's
  // revision does not move and the hub is right to hear nothing -- but this subscriber just grew a
  // row, which is the thing it exists to draw.
  sessions.delete("pi:session-1");
  notifyCatalog();
  await settle();
  expect(drawn.at(-1)).toEqual([1]);
  stop();
});

test("and told when it resolves again, which is the half the bug dropped", async () => {
  const { registry } = await aBotHoldingAResolvableReference();
  const held = sessions.get("pi:session-1")!;
  const drawn: number[] = [];
  const stop = await registry.subscribe(
    (snapshot) => drawn.push(snapshot.bots[0]!.missingSessionRefs.length),
    undefined,
    { onChange: "view" },
  );
  const before = drawn.length;

  sessions.delete("pi:session-1");
  notifyCatalog();
  await settle();
  sessions.set("pi:session-1", held);
  notifyCatalog();
  await settle();

  // Two emissions, not one. A subscriber told only that the row appeared is left showing a session
  // the machine has, and that is the state this whole file exists because of.
  expect(drawn.length).toBe(before + 2);
  expect(drawn.at(-1)).toBe(0);
  stop();
});

test("a view subscriber is not woken by writes inside the minute a card already shows", async () => {
  // The constraint that keeps this from being the hundred-a-minute flood wearing a new hat. A write
  // moves `lastEventAt`; the card prints hours and minutes, so a write that leaves the minute where
  // it was has nothing new to draw.
  const { registry } = await aBotHoldingAResolvableReference();
  const held = sessions.get("pi:session-1")!;
  const woken: number[] = [];
  const stop = await registry.subscribe(() => woken.push(1), undefined, { onChange: "view" });
  woken.length = 0;

  for (const lastEventAt of [5_000, 30_000, 59_999]) {
    sessions.set("pi:session-1", { ...held, summary: { ...held.summary, lastEventAt } });
    notifyCatalog();
  }
  await settle();
  expect(woken).toEqual([]);
  stop();
});

test("a view subscriber IS woken when the minute or the activity a card shows moves", async () => {
  // Measured 2026-10-17: a card held "ready" and a time 42 seconds old while its session wrote
  // throughout, because this stream sent its opening snapshot and nothing after.
  const { registry } = await aBotHoldingAResolvableReference();
  const held = sessions.get("pi:session-1")!;
  const drawn: string[] = [];
  const stop = await registry.subscribe(
    (snapshot) => {
      const one = snapshot.bots[0]!.sessions[0]!;
      drawn.push(`${one.activity}@${one.lastEventAt}`);
    },
    undefined,
    { onChange: "view" },
  );
  const before = drawn.length;

  sessions.set("pi:session-1", { ...held, summary: { ...held.summary, lastEventAt: 61_000 } });
  notifyCatalog();
  await settle();
  sessions.set("pi:session-1", { ...held, summary: { ...held.summary, lastEventAt: 61_000, activity: "live" } });
  notifyCatalog();
  await settle();

  expect(drawn.slice(before)).toEqual([`${held.summary.activity}@61000`, "live@61000"]);
  stop();
});

test("a view subscriber IS woken by a rename, which is a value change and not a write", async () => {
  // The half that used to be missing, and the reason the signature carries a title. Measured on the
  // transcripts: 74,631 records across 55 sessions moved a title 5 times, so a title is not the
  // churn the counters are -- and a renamed row that keeps drawing the old name is a rename that
  // reads as one that did nothing.
  const { registry } = await aBotHoldingAResolvableReference();
  const held = sessions.get("pi:session-1")!;
  const drawn: string[] = [];
  const stop = await registry.subscribe((snapshot) => drawn.push(snapshot.bots[0]!.sessions[0]!.title), undefined, {
    onChange: "view",
  });
  const before = drawn.length;

  sessions.set("pi:session-1", { ...held, summary: { ...held.summary, title: "What I called it" } });
  notifyCatalog();
  await settle();
  expect(drawn.length).toBe(before + 1);
  expect(drawn.at(-1)).toBe("What I called it");

  // And a re-emission of that same title is not a change, which is the case that made a title look
  // like it moved on every write: Claude re-emits its generated title as a session goes on.
  sessions.set("pi:session-1", {
    ...held,
    summary: { ...held.summary, title: "What I called it", lastEventAt: 99 },
  });
  notifyCatalog();
  await settle();
  expect(drawn).toHaveLength(before + 1);
  stop();
});

test("a view subscriber IS woken by a new task block, which the card draws under the title", async () => {
  // A block is written once per piece of handed-over work. Left out of the signature, a new one
  // reached the card only when a title or a reference happened to move as well.
  const { registry } = await aBotHoldingAResolvableReference();
  const held = sessions.get("pi:session-1")!;
  const drawn: (string | undefined)[] = [];
  const stop = await registry.subscribe(
    (snapshot) => drawn.push(snapshot.bots[0]!.sessions[0]!.taskState?.task),
    undefined,
    { onChange: "view" },
  );
  const before = drawn.length;

  const block = { task: "fix the lag", lines: [], at: 1000 };
  sessions.set("pi:session-1", { ...held, summary: { ...held.summary, taskState: block } });
  notifyCatalog();
  await settle();
  expect(drawn.length).toBe(before + 1);
  expect(drawn.at(-1)).toBe("fix the lag");

  // The same block read again on a later write is not a change.
  sessions.set("pi:session-1", { ...held, summary: { ...held.summary, taskState: block, lastEventAt: 99 } });
  notifyCatalog();
  await settle();
  expect(drawn).toHaveLength(before + 1);
  stop();
});

test('a "store" subscriber is still not woken by a reference resolving either', async () => {
  // The other half of the same fix: the hub's flood protection is unchanged, because a reference
  // appearing or disappearing says nothing about a Bot's membership.
  const { registry } = await aBotHoldingAResolvableReference();
  const woken: number[] = [];
  const stop = await registry.subscribe(() => woken.push(1));
  woken.length = 0;

  sessions.delete("pi:session-1");
  notifyCatalog();
  await settle();
  expect(woken).toEqual([]);
  stop();
});
