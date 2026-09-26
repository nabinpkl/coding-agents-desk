import { expect, test } from "bun:test";
import { join } from "node:path";
import {
  BotConflictError,
  BotForbiddenError,
  BotNotFoundError,
} from "@/bots/botRegistry";
import { botRegistryHarness } from "@/bots/botRegistryHarness";

const { addBot, addSessions, fixture, projects, recordingLauncher, sessions, summary, temporaryDirectories } = botRegistryHarness();

test("adds a user-facing Bot for an existing project directory with no sessions", async () => {
  const { project, registry } = await fixture();
  const bot = await addBot(registry, {
    requestId: "request-1",
    name: "Release Captain",
    iconUrl: "https://example.com/captain.png",
    directoryPath: project,
    metadata: { role: "Own releases", labels: ["release"], custom: { team: "platform" } },
    grants: ["add_bot"],
  }, { kind: "user" });

  expect(bot).toMatchObject({
    botId: "bot-1",
    name: "Release Captain",
    iconUrl: "https://example.com/captain.png",
    environment: { kind: "directory", path: project },
    sessionRefs: [],
    sessions: [],
    missingSessionRefs: [],
    metadata: { role: "Own releases", labels: ["release"], custom: { team: "platform" } },
    grants: ["add_bot"],
    createdBy: { kind: "user" },
    environmentAvailability: "available",
  });
});

test("retries add idempotently and enforces unique names and directories", async () => {
  const { project, secondProject, registry } = await fixture();
  const command = { requestId: "same", name: "Captain", directoryPath: project };
  const first = await addBot(registry, command, { kind: "user" });
  expect((await addBot(registry, command, { kind: "user" })).botId).toBe(first.botId);
  await expect(addBot(registry, { ...command, name: "Different" }, { kind: "user" }))
    .rejects.toBeInstanceOf(BotConflictError);
  await expect(addBot(registry, { requestId: "two", name: "captain", directoryPath: secondProject }, { kind: "user" }))
    .rejects.toBeInstanceOf(BotConflictError);
  await expect(addBot(registry, { requestId: "three", name: "Reviewer", directoryPath: project }, { kind: "user" }))
    .rejects.toBeInstanceOf(BotConflictError);
});

test("attaches existing sessions from the Bot directory as one durable update", async () => {
  const { project, ref, secondRef, registry } = await fixture();
  const bot = await addBot(registry, { requestId: "add", name: "Captain", directoryPath: project }, { kind: "user" });
  const command = { requestId: "attach", sessionRefs: [ref, secondRef] };
  const attached = await addSessions(registry, bot.botId, command, { kind: "user" });

  expect(attached.sessionRefs).toEqual([ref, secondRef]);
  expect(attached.sessions).toEqual([summary(ref), summary(secondRef, false)]);
  expect((await addSessions(registry, bot.botId, command, { kind: "user" })).sessionRefs).toEqual([ref, secondRef]);
  expect((await registry.snapshot()).revision).toBe(2);
});

test("a reorder moves the order and nothing else; detach keeps the slot for the return", async () => {
  // The reason slots are stored rather than ranked: a reader who drags a card is arranging, and
  // an arrangement that repaints every session it passed is not one.
  const { project, ref, secondRef, registry } = await fixture();
  const bot = await addBot(registry, { requestId: "add", name: "Captain", directoryPath: project }, { kind: "user" });
  await addSessions(registry, bot.botId, { requestId: "attach", sessionRefs: [ref, secondRef] }, { kind: "user" });

  const reordered = await registry.reorderSessions(
    bot.botId,
    { requestId: "move", sessionRefs: [secondRef, ref] },
    { kind: "user" },
  );
  expect(reordered.sessionRefs).toEqual([secondRef, ref]);
  expect(reordered.sessionSlots).toEqual({ "pi:session-1": 0, "codex:session-2": 1 });
  expect(reordered.nextSessionSlot).toBe(2);

  const detached = await registry.detachSessions(
    bot.botId,
    { requestId: "leave", sessionRefs: [secondRef] },
    { kind: "user" },
  );
  expect(detached.sessionRefs).toEqual([ref]);
  expect(detached.sessionSlots).toEqual({ "pi:session-1": 0, "codex:session-2": 1 });

  const returned = await addSessions(
    registry,
    bot.botId,
    { requestId: "back", sessionRefs: [secondRef] },
    { kind: "user" },
  );
  expect(returned.sessionSlots).toEqual({ "pi:session-1": 0, "codex:session-2": 1 });
  expect(returned.nextSessionSlot).toBe(2);
});

test("rejects sessions outside the Bot directory and request reuse across Bots", async () => {
  const { project, secondProject, ref, registry } = await fixture();
  const first = await addBot(registry, { requestId: "first", name: "First", directoryPath: project }, { kind: "user" });
  const second = await addBot(registry, { requestId: "second", name: "Second", directoryPath: secondProject }, { kind: "user" });

  await expect(addSessions(registry, second.botId, { requestId: "outside", sessionRefs: [ref] }, { kind: "user" }))
    .rejects.toBeInstanceOf(BotConflictError);
  await addSessions(registry, first.botId, { requestId: "shared", sessionRefs: [ref] }, { kind: "user" });
  await expect(addSessions(registry, second.botId, { requestId: "shared", sessionRefs: [ref] }, { kind: "user" }))
    .rejects.toBeInstanceOf(BotConflictError);
});

test("permits only an attached session of a granted Bot to call add_bot", async () => {
  const { project, secondProject, ref, registry } = await fixture();
  const chief = await addBot(registry, {
    requestId: "chief",
    name: "Chief of Staff",
    directoryPath: project,
    grants: ["add_bot"],
  }, { kind: "user" });
  await addSessions(registry, chief.botId, { requestId: "attach-chief", sessionRefs: [ref] }, { kind: "user" });

  const created = await addBot(registry, { requestId: "tool-call", name: "Reviewer", directoryPath: secondProject }, {
    kind: "agent",
    session: ref,
  });
  expect(created.createdBy).toEqual({ kind: "bot", botId: chief.botId });
  expect(created.sessionRefs).toEqual([]);
  expect(created.grants).toEqual([]);

  await expect(addBot(registry, { requestId: "forbidden", name: "Third", directoryPath: secondProject }, {
    kind: "agent",
    session: { source: "pi", sessionId: "unattached" },
  })).rejects.toBeInstanceOf(BotForbiddenError);
  await expect(addBot(registry, {
    requestId: "delegate",
    name: "Delegated",
    directoryPath: secondProject,
    grants: ["add_bot"],
  }, { kind: "agent", session: ref })).rejects.toBeInstanceOf(BotForbiddenError);
});

test("rejects directories and sessions outside the current catalog", async () => {
  const { project, registry } = await fixture();
  await expect(addBot(registry, { requestId: "missing", name: "Missing", directoryPath: join(project, "unknown") }, { kind: "user" }))
    .rejects.toBeInstanceOf(BotNotFoundError);

  const bot = await addBot(registry, { requestId: "known", name: "Known", directoryPath: project }, { kind: "user" });
  await expect(addSessions(registry, bot.botId, {
    requestId: "missing-session",
    sessionRefs: [{ source: "claude", sessionId: "missing" }],
  }, { kind: "user" })).rejects.toBeInstanceOf(BotNotFoundError);
});

test("detaches a session and leaves the rest of the projection alone", async () => {
  const { project, ref, secondRef, registry } = await fixture();
  const bot = await addBot(registry, { requestId: "add", name: "Captain", directoryPath: project }, { kind: "user" });
  await addSessions(registry, bot.botId, { requestId: "attach", sessionRefs: [ref, secondRef] }, { kind: "user" });

  const command = { requestId: "detach", sessionRefs: [ref] };
  const detached = await registry.detachSessions(bot.botId, command, { kind: "user" });

  expect(detached.sessionRefs).toEqual([secondRef]);
  expect(detached.sessions).toEqual([summary(secondRef, false)]);
  // Replayed rather than reapplied: a retried removal must not read as "already gone".
  expect((await registry.detachSessions(bot.botId, command, { kind: "user" })).sessionRefs).toEqual([secondRef]);
  expect((await registry.snapshot()).revision).toBe(3);
});

test("detaches a session the catalog has forgotten", async () => {
  const { project, ref, registry } = await fixture();
  const bot = await addBot(registry, { requestId: "add", name: "Captain", directoryPath: project }, { kind: "user" });
  await addSessions(registry, bot.botId, { requestId: "attach", sessionRefs: [ref] }, { kind: "user" });

  // The transcript is gone from the catalog, so the Bot now carries it as a missing reference.
  // Attaching resolves against the catalog; detaching must not, or this row could never leave.
  sessions.delete(`${ref.source}:${ref.sessionId}`);
  expect((await registry.snapshot()).bots[0]!.missingSessionRefs).toEqual([ref]);

  const detached = await registry.detachSessions(
    bot.botId,
    { requestId: "detach-missing", sessionRefs: [ref] },
    { kind: "user" },
  );
  expect(detached.sessionRefs).toEqual([]);
  expect(detached.missingSessionRefs).toEqual([]);
});

test("refuses to detach what a Bot does not hold, and refuses agent actors entirely", async () => {
  const { project, ref, secondRef, registry } = await fixture();
  const bot = await addBot(registry, { requestId: "add", name: "Captain", directoryPath: project }, { kind: "user" });
  await addSessions(registry, bot.botId, { requestId: "attach", sessionRefs: [ref] }, { kind: "user" });

  await expect(registry.detachSessions(bot.botId, { requestId: "absent", sessionRefs: [secondRef] }, { kind: "user" }))
    .rejects.toBeInstanceOf(BotNotFoundError);
  await expect(registry.detachSessions("missing-bot", { requestId: "no-bot", sessionRefs: [ref] }, { kind: "user" }))
    .rejects.toBeInstanceOf(BotNotFoundError);
  // Curating the roster is the user's, not a granted Bot's: `add_bot` widens what an agent may
  // create, never what it may take away.
  await expect(registry.detachSessions(bot.botId, { requestId: "agent", sessionRefs: [ref] }, {
    kind: "agent",
    session: ref,
  })).rejects.toBeInstanceOf(BotForbiddenError);
  expect((await registry.snapshot()).bots[0]!.sessionRefs).toEqual([ref]);
});
