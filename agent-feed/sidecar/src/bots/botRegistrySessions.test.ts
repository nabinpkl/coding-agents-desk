// Adding sessions to a Bot that already has some: which directories count as the Bot's,
// which session gets a label, and what forking one of its own sessions carries over.

import { expect, test } from "bun:test";
import { BotConflictError, BotNotFoundError } from "@/bots/botRegistry";
import { botRegistryHarness } from "@/bots/botRegistryHarness";

const { addBot, addSessions, checkoutWithWorktree, fixture, projects, recordingLauncher, sessions, summary } = botRegistryHarness();

test("attaches a session working in a git worktree of the Bot's directory", async () => {
  // A worktree is the same project by every meaning a reader has, and refusing it made isolation
  // cost a Bot its view of the work being done for it.
  const { registry } = await fixture();
  const { checkout, worktree } = await checkoutWithWorktree();
  projects.add(checkout);
  const ref = { source: "claude" as const, sessionId: "in-worktree" };
  sessions.set("claude:in-worktree", { projectPath: worktree, summary: summary(ref) });

  const bot = await addBot(registry, 
    { requestId: "r1", name: "Repo bot", directoryPath: checkout },
    { kind: "user" },
  );
  const attached = await addSessions(registry, 
    bot.botId,
    { requestId: "r2", sessionRefs: [ref] },
    { kind: "user" },
  );

  expect(attached.sessions.map((session) => session.sessionId)).toEqual(["in-worktree"]);
  expect(attached.missingSessionRefs).toEqual([]);
  // And the row says which branch, because otherwise it is indistinguishable from a session in the
  // checkout itself while editing entirely different files.
  expect(attached.sessions[0]!.worktree).toEqual({ path: worktree, branch: "side" });
});

test("still refuses a session from a directory that is not the Bot's and not a worktree of it", async () => {
  const { registry, secondProject, secondRef } = await fixture();
  const { checkout } = await checkoutWithWorktree();
  projects.add(checkout);
  sessions.set(`codex:${secondRef.sessionId}`, {
    projectPath: secondProject,
    summary: summary(secondRef),
  });

  const bot = await addBot(registry, 
    { requestId: "r1", name: "Repo bot", directoryPath: checkout },
    { kind: "user" },
  );

  await expect(addSessions(registry, 
    bot.botId,
    { requestId: "r2", sessionRefs: [secondRef] },
    { kind: "user" },
  )).rejects.toThrow(BotConflictError);
});

test("leaves a session in the Bot's own directory unlabelled, so the label means something", async () => {
  // A field present and empty on every ordinary row is one every reader learns to ignore.
  const { registry, project, ref } = await fixture();

  const bot = await addBot(registry, 
    { requestId: "r1", name: "Plain bot", directoryPath: project },
    { kind: "user" },
  );
  const attached = await addSessions(registry, 
    bot.botId,
    { requestId: "r2", sessionRefs: [ref] },
    { kind: "user" },
  );

  expect(attached.sessions[0]!.worktree).toBeUndefined();
});

test("starts a session on a Bot that already has some, and attaches it", async () => {
  const { launched, launcher } = recordingLauncher();
  const { project, registry } = await fixture(launcher);

  const bot = await addBot(registry, {
    requestId: "add",
    name: "AD bot",
    directoryPath: project,
  }, { kind: "user" });
  const added = await registry.addSessions(
    bot.botId,
    { requestId: "start", launch: { title: "composer fix", prompt: "Read the brief." } },
    { kind: "user" },
  );

  // The first free anchor, with the request bracketed after it. The reservation is spent
  // before the launch, so the stored anchor and the `-n` title always agree.
  expect(launched).toEqual([{
    kind: "start",
    cwd: project,
    sessionId: "started-1",
    title: "Aaron (composer fix)",
    prompt: "Read the brief.",
  }]);
  // The pane comes back with it: the caller has nowhere else to read it from, and rebuilding the
  // name at the call site would put the sidecar's rule in two places.
  expect(added.started).toEqual({
    sessionId: "started-1",
    title: "Aaron (composer fix)",
    projectPath: project,
    tmuxSession: "agentdesk-started-1",
  });
  expect(added.bot.missingSessionRefs).toEqual([{ source: "claude", sessionId: "started-1" }]);
  expect(added.bot.sessionSlots).toEqual({ "claude:started-1": 0 });
  expect(added.bot.sessionAnchors).toEqual({ "claude:started-1": "Aaron" });
  expect(added.bot.nextSessionSlot).toBe(1);
});

test("forks one of the Bot's own sessions, and puts the brief behind the handoff note", async () => {
  const { launched, launcher } = recordingLauncher();
  const { project, claudeRef, registry } = await fixture(launcher);

  const bot = await addBot(registry, {
    requestId: "add",
    name: "AD bot",
    directoryPath: project,
  }, { kind: "user" });
  await addSessions(registry, bot.botId, { requestId: "attach", sessionRefs: [claudeRef] }, { kind: "user" });
  const added = await registry.addSessions(
    bot.botId,
    {
      requestId: "fork",
      launch: { title: "Bot background color", from: claudeRef, prompt: "Give each card a colour." },
    },
    { kind: "user" },
  );

  expect(launched).toEqual([{
    kind: "fork",
    cwd: project,
    sessionId: claudeRef.sessionId,
    forkId: "started-1",
    // The attach spent Aaron, so the fork takes Adam and the request brackets after it.
    title: "Adam (Bot background color)",
    // The launcher composes the handoff note in front of this; what the registry passes is the
    // reader's own words, unchanged.
    brief: "Give each card a colour.",
  }]);
  expect(added.started?.tmuxSession).toBe("agentdesk-fork-started-1");
  expect(added.started?.title).toBe("Adam (Bot background color)");
  expect(added.bot.sessionSlots?.["claude:started-1"]).toBe(1);
  expect(added.bot.sessionAnchors?.["claude:started-1"]).toBe("Adam");
});

test("refuses to fork a session the Bot does not hold", async () => {
  // A Bot is what says which sessions belong to a directory, so "fork that one" is only meaningful
  // about a session it holds. Without this a Bot could branch a stranger's transcript into itself.
  const { project, claudeRef, registry } = await fixture();

  const bot = await addBot(registry, {
    requestId: "add",
    name: "AD bot",
    directoryPath: project,
  }, { kind: "user" });

  await expect(registry.addSessions(
    bot.botId,
    { requestId: "fork", launch: { title: "Nope", from: claudeRef } },
    { kind: "user" },
  )).rejects.toThrow(BotNotFoundError);
});

test("an omitted title starts bare under the next free anchor", async () => {
  // The anchor is spent from the slot counter, not counted from titles, so two launches in one
  // moment cannot preview the same name and a deleted session's number is never reused.
  const { launched, launcher } = recordingLauncher();
  const { project, registry } = await fixture(launcher);
  const bot = await addBot(registry, {
    requestId: "add",
    name: "AD bot",
    directoryPath: project,
  }, { kind: "user" });

  const added = await registry.addSessions(bot.botId, { requestId: "start", launch: {} }, { kind: "user" });

  expect(launched).toEqual([{
    kind: "start",
    cwd: project,
    sessionId: "started-1",
    title: "Aaron",
    prompt: undefined,
  }]);
  expect(added.started?.title).toBe("Aaron");
  expect(added.bot.sessionSlots).toEqual({ "claude:started-1": 0 });
  expect(added.bot.sessionAnchors).toEqual({ "claude:started-1": "Aaron" });
});

test("a task carrying its own brackets is refused before anything is spent", async () => {
  const { launched, launcher } = recordingLauncher();
  const { project, registry } = await fixture(launcher);
  const bot = await addBot(registry, {
    requestId: "add",
    name: "AD bot",
    directoryPath: project,
  }, { kind: "user" });

  await expect(registry.addSessions(
    bot.botId,
    { requestId: "start", launch: { title: "fix (urgent) bug" } },
    { kind: "user" },
  )).rejects.toThrow(/parentheses/);
  expect(launched).toEqual([]);
});

test("refuses a command that neither attaches nor starts anything", async () => {
  const { project, registry } = await fixture();
  const bot = await addBot(registry, {
    requestId: "add",
    name: "AD bot",
    directoryPath: project,
  }, { kind: "user" });

  await expect(registry.addSessions(bot.botId, { requestId: "empty" }, { kind: "user" }))
    .rejects.toThrow(/sessionRefs or launch is required/);
});

test("creates a Bot whose first session is a fork of one already in its directory", async () => {
  // The same launch shape at both endpoints. A directory can already hold sessions when its Bot is
  // created, and branching one of those into the new Bot's first session is the same act as
  // branching one later.
  const { launched, launcher } = recordingLauncher();
  const { project, claudeRef, registry } = await fixture(launcher);

  const first = await addBot(registry, {
    requestId: "add-first",
    name: "First",
    directoryPath: project,
  }, { kind: "user" });
  await addSessions(registry, first.botId, { requestId: "attach", sessionRefs: [claudeRef] }, { kind: "user" });

  // A second Bot cannot take the same directory, so the fork source is checked against the Bot
  // being created rather than against any Bot -- and this one holds nothing yet.
  await expect(registry.add({
    requestId: "add-second",
    name: "Second",
    directoryPath: project,
    launch: { title: "Branch", from: claudeRef },
  }, { kind: "user" })).rejects.toThrow(BotConflictError);
  expect(launched).toEqual([]);
});
