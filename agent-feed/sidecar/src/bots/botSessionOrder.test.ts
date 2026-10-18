// Reordering a Bot's sessions: what it changes, and what it refuses when the caller is out of date.

import { expect, test } from "bun:test";
import { BotConflictError, BotForbiddenError, BotNotFoundError } from "@/bots/botRegistry";
import { botRegistryHarness } from "@/bots/botRegistryHarness";

const { addBot, addSessions, fixture } = botRegistryHarness();

/** A Bot holding all three of the fixture's sessions, in the order they were attached. */
async function botWithThree() {
  const { registry, project, ref, secondRef, claudeRef } = await fixture();
  const created = await addBot(
    registry,
    { requestId: "r1", name: "Roster bot", directoryPath: project },
    { kind: "user" },
  );
  const bot = await addSessions(
    registry,
    created.botId,
    { requestId: "r2", sessionRefs: [ref, secondRef, claudeRef] },
    { kind: "user" },
  );
  expect(bot.sessionRefs.map((each) => each.sessionId)).toEqual(["session-1", "session-2", "session-3"]);
  return { registry, botId: bot.botId, ref, secondRef, claudeRef };
}

test("stands the same sessions in the order given", async () => {
  const { registry, botId, ref, secondRef, claudeRef } = await botWithThree();

  const reordered = await registry.reorderSessions(
    botId,
    { requestId: "r3", sessionRefs: [claudeRef, ref, secondRef] },
    { kind: "user" },
  );

  expect(reordered.sessionRefs.map((each) => each.sessionId)).toEqual(["session-3", "session-1", "session-2"]);
  // The resolved summaries follow the durable order, which is what the panel ranks colours by and
  // lays cards out in. A record that moved while its view did not would be a reorder nobody sees.
  expect(reordered.sessions.map((each) => each.sessionId)).toEqual(["session-3", "session-1", "session-2"]);
});

test("survives a reload, because the order is the record rather than the view", async () => {
  const { registry, botId, ref, secondRef, claudeRef } = await botWithThree();
  await registry.reorderSessions(
    botId,
    { requestId: "r3", sessionRefs: [secondRef, claudeRef, ref] },
    { kind: "user" },
  );

  const snapshot = await registry.snapshot();

  expect(snapshot.bots[0]!.sessionRefs.map((each) => each.sessionId)).toEqual(["session-2", "session-3", "session-1"]);
});

test("refuses an order that is missing one of the Bot's sessions", async () => {
  // The stale-caller case: a panel naming the order it rendered, after a session was attached to
  // the same Bot somewhere else. Taking it as complete would detach what arrived.
  const { registry, botId, ref, claudeRef } = await botWithThree();

  await expect(
    registry.reorderSessions(botId, { requestId: "r3", sessionRefs: [claudeRef, ref] }, { kind: "user" }),
  ).rejects.toThrow(BotConflictError);

  const snapshot = await registry.snapshot();
  expect(snapshot.bots[0]!.sessionRefs).toHaveLength(3);
});

test("refuses an order naming a session this Bot does not hold", async () => {
  const { registry, botId, ref, secondRef } = await botWithThree();

  await expect(
    registry.reorderSessions(
      botId,
      { requestId: "r3", sessionRefs: [ref, secondRef, { source: "claude", sessionId: "elsewhere" }] },
      { kind: "user" },
    ),
  ).rejects.toThrow(BotNotFoundError);
});

test("answers a resent request with the order the first one made, rather than applying it twice", async () => {
  const { registry, botId, ref, secondRef, claudeRef } = await botWithThree();
  const order = { requestId: "r3", sessionRefs: [claudeRef, secondRef, ref] };

  const first = await registry.reorderSessions(botId, order, { kind: "user" });
  const written = (await registry.snapshot()).revision;
  const replayed = await registry.reorderSessions(botId, order, { kind: "user" });

  expect(replayed.sessionRefs).toEqual(first.sessionRefs);
  const snapshot = await registry.snapshot();
  // The replay wrote nothing at all, which is what distinguishes answering a resent request from
  // applying the same order twice. Reordering happens to be its own inverse-free act -- running it
  // again lands the same list -- so the revision is the only thing that can tell the two apart.
  expect(snapshot.revision).toBe(written);
  expect(snapshot.bots[0]!.sessionRefs.map((each) => each.sessionId)).toEqual(["session-3", "session-2", "session-1"]);
});

test("is the authenticated user's alone, like every other edit to a Bot's curation", async () => {
  const { registry, botId, ref, secondRef, claudeRef } = await botWithThree();

  await expect(
    registry.reorderSessions(
      botId,
      { requestId: "r3", sessionRefs: [claudeRef, secondRef, ref] },
      { kind: "agent", session: ref },
    ),
  ).rejects.toThrow(BotForbiddenError);
});
