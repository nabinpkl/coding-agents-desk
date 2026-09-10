// Adding sessions to a Bot that already has some: which directories count as the Bot's,
// which session gets a label, and what forking one of its own sessions carries over.

import { expect, test } from "bun:test";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotConflictError, BotNotFoundError } from "@/bots/botRegistry";
import { botRegistryHarness } from "@/bots/botRegistryHarness";

const { addBot, addSessions, fixture, projects, recordingLauncher, sessions, summary, temporaryDirectories } = botRegistryHarness();

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
    { requestId: "start", launch: { title: "AD composer fix", prompt: "Read the brief." } },
    { kind: "user" },
  );

  expect(launched).toEqual([{
    kind: "start",
    cwd: project,
    sessionId: "started-1",
    title: "AD composer fix",
    prompt: "Read the brief.",
  }]);
  // The pane comes back with it: the caller has nowhere else to read it from, and rebuilding the
  // name at the call site would put the sidecar's rule in two places.
  expect(added.started).toEqual({
    sessionId: "started-1",
    title: "AD composer fix",
    projectPath: project,
    tmuxSession: "agentdesk-started-1",
  });
  expect(added.bot.missingSessionRefs).toEqual([{ source: "claude", sessionId: "started-1" }]);
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
    title: "Bot background color",
    // The launcher composes the handoff note in front of this; what the registry passes is the
    // reader's own words, unchanged.
    brief: "Give each card a colour.",
  }]);
  expect(added.started?.tmuxSession).toBe("agentdesk-fork-started-1");
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

test("requires a title when adding a session to a Bot that already has one", async () => {
  // At creation the Bot's name is the obvious title for its only session. Here it is the opposite:
  // every session would answer to the same address, and `-n` is what other agents send to.
  const { project, registry } = await fixture();
  const bot = await addBot(registry, {
    requestId: "add",
    name: "AD bot",
    directoryPath: project,
  }, { kind: "user" });

  await expect(registry.addSessions(bot.botId, { requestId: "start", launch: {} }, { kind: "user" }))
    .rejects.toThrow(/launch.title is required/);
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

async function git(command: string[], cwd: string): Promise<void> {
  const process = Bun.spawn(["git", ...command], { cwd, stdout: "ignore", stderr: "ignore" });
  const code = await process.exited;
  if (code !== 0) throw new Error(`git ${command.join(" ")} exited ${code}`);
}

/** A Bot's directory as a real repository, with one linked worktree beside it. */
async function checkoutWithWorktree(): Promise<{ checkout: string; worktree: string }> {
  const created = await mkdtemp(join(tmpdir(), "agentdesk-bots-worktree-"));
  temporaryDirectories.push(created);
  const root = await realpath(created);
  const checkout = join(root, "checkout");
  await git(["init", "-q", "-b", "main", checkout], root);
  await writeFile(join(checkout, "README"), "x\n");
  await git(["add", "README"], checkout);
  await git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "one"], checkout);
  const worktree = join(root, "side");
  await git(["worktree", "add", "-q", worktree, "-b", "side"], checkout);
  return { checkout, worktree };
}
