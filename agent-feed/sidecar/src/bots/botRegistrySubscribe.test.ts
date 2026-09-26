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

const { addBot, addSessions, fixture, notifyCatalog, sessions, summary } = botRegistryHarness();

/** The emit is queued on a promise chain and reads the store, so it lands a tick or two later. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10));

async function aBotWithASession() {
  const world = await fixture();
  const bot = await addBot(
    world.registry,
    { requestId: "r1", name: "Release Captain", directoryPath: world.project, metadata: { role: "x", labels: ["release"], custom: {} }, grants: ["add_bot"] },
    { kind: "user" },
  );
  return { ...world, bot };
}

test("a subscriber is woken once for the current state, and not again for session churn", async () => {
  const { registry, bot } = await aBotWithASession();
  await addSessions(registry, bot.botId, { requestId: "r2", sessionRefs: [{ source: "pi", sessionId: "session-1" }] }, { kind: "user" });

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
  await addSessions(registry, bot.botId, { requestId: "r2", sessionRefs: [{ source: "pi", sessionId: "session-1" }] }, { kind: "user" });
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
    { requestId: "r1", name: "Second", directoryPath: world.secondProject, metadata: { role: "y", labels: ["ops"], custom: {} }, grants: ["add_bot"] },
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
  await addSessions(registry, bot.botId, { requestId: "r2", sessionRefs: [{ source: "pi", sessionId: "session-1" }] }, { kind: "user" });
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

test('a subscriber drawing the view is told when a reference stops resolving', async () => {
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

test("a view subscriber is still not woken by a session's own counters moving", async () => {
  // The constraint that keeps this from being the hundred-a-minute flood wearing a new hat. The
  // comparison is identity, not content: a title, a token count and an activity all move on an
  // ordinary transcript write, and a panel already hears those from the session catalog stream.
  const { registry } = await aBotHoldingAResolvableReference();
  const held = sessions.get("pi:session-1")!;
  const woken: number[] = [];
  const stop = await registry.subscribe(
    () => woken.push(1),
    undefined,
    { onChange: "view" },
  );
  woken.length = 0;

  sessions.set("pi:session-1", {
    ...held,
    summary: { ...held.summary, lastEventAt: held.summary.lastEventAt + 5000, title: "moved" },
  });
  notifyCatalog();
  await settle();
  expect(woken).toEqual([]);
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
