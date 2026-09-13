// Retiring a Bot's session: what it ends, what it removes, what it refuses before touching
// anything, and what it reports when a step fails after the refusals have passed.
//
// Against a real repository with a real worktree, because every refusal worth having here is one
// git decides: whether a directory is a worktree of THIS checkout, whether it is clean, and whether
// a branch is merged enough to lose. A fake would agree with whatever this file assumed.

import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BotConflictError, BotForbiddenError, BotInvalidError, BotNotFoundError } from "@/bots/botRegistry";
import { botRegistryHarness } from "@/bots/botRegistryHarness";
import { readWorktree } from "@/git/worktree";

const {
  addBot,
  addSessions,
  checkoutWithWorktree,
  endedPanes,
  fixture,
  git,
  projects,
  runningPanes,
  sessions,
  summary,
} = botRegistryHarness();

/** A Bot bound to a real checkout, holding one session that works in a worktree of it. */
async function botInWorktree() {
  const { registry } = await fixture();
  const { checkout, worktree } = await checkoutWithWorktree();
  projects.add(checkout);
  const ref = { source: "claude" as const, sessionId: "in-worktree" };
  sessions.set("claude:in-worktree", { projectPath: worktree, summary: summary(ref) });
  const bot = await addBot(registry, { requestId: "add", name: "Repo bot", directoryPath: checkout }, { kind: "user" });
  await addSessions(registry, bot.botId, { requestId: "attach", sessionRefs: [ref] }, { kind: "user" });
  return { registry, checkout, worktree, ref, botId: bot.botId };
}

test("the default body ends the session and forgets it, and touches no disk", async () => {
  const { registry, botId, ref, worktree } = await botInWorktree();
  runningPanes.set(ref.sessionId, "agentdesk-in-worktree");

  const { bot, retired } = await registry.retireSessions(botId, {
    requestId: "retire",
    sessionRefs: [ref],
  }, { kind: "user" });

  expect(bot.sessionRefs).toEqual([]);
  expect(endedPanes).toEqual(["agentdesk-in-worktree"]);
  expect(retired).toEqual([{ ...ref, endedPane: "agentdesk-in-worktree", failed: [] }]);
  // Keeping is the default for every disposal, so the worktree is still a worktree.
  expect(await readWorktree(worktree)).not.toBeNull();
});

test("a session that has already stopped is retired without that being a failure", async () => {
  const { registry, botId, ref } = await botInWorktree();

  const { retired } = await registry.retireSessions(botId, {
    requestId: "retire",
    sessionRefs: [ref],
  }, { kind: "user" });

  expect(endedPanes).toEqual([]);
  expect(retired[0]!.endedPane).toBeUndefined();
  expect(retired[0]!.failed).toEqual([]);
});

test("removes the worktree and deletes its branch when both are asked for", async () => {
  const { registry, botId, ref, checkout, worktree } = await botInWorktree();
  // Merged into main, so `git branch -d` will take it.
  await git(["merge", "-q", "side"], checkout);

  const { retired } = await registry.retireSessions(botId, {
    requestId: "retire",
    sessionRefs: [ref],
    worktree: "remove",
    branch: "delete",
  }, { kind: "user" });

  expect(retired[0]).toEqual({ ...ref, removedWorktree: worktree, deletedBranch: "side", failed: [] });
  expect(await readWorktree(worktree)).toBeNull();
  const branches = Bun.spawnSync(["git", "branch", "--format=%(refname:short)"], { cwd: checkout });
  expect(branches.stdout.toString().split("\n").filter(Boolean)).toEqual(["main"]);
});

test("an unmerged branch survives, and the worktree is still gone", async () => {
  const { registry, botId, ref, checkout, worktree } = await botInWorktree();
  await writeFile(join(worktree, "work"), "unmerged\n");
  await git(["add", "work"], worktree);
  await git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "unmerged"], worktree);

  const { retired } = await registry.retireSessions(botId, {
    requestId: "retire",
    sessionRefs: [ref],
    worktree: "remove",
    branch: "delete",
  }, { kind: "user" });

  // The asymmetry the ordering forces: a checked-out branch cannot be deleted, so the worktree goes
  // first and `git branch -d` then refuses. The commits are what matter and they are all still here.
  expect(retired[0]!.removedWorktree).toBe(worktree);
  expect(retired[0]!.deletedBranch).toBeUndefined();
  expect(retired[0]!.failed).toEqual([{ step: "branch", reason: expect.stringContaining("git branch -d side failed") }]);
  const branches = Bun.spawnSync(["git", "branch", "--format=%(refname:short)"], { cwd: checkout });
  expect(branches.stdout.toString()).toContain("side");
});

test("a dirty worktree is refused, and nothing at all happens", async () => {
  const { registry, botId, ref, worktree } = await botInWorktree();
  runningPanes.set(ref.sessionId, "agentdesk-in-worktree");
  await writeFile(join(worktree, "scratch"), "uncommitted\n");

  await expect(registry.retireSessions(botId, {
    requestId: "retire",
    sessionRefs: [ref],
    worktree: "remove",
  }, { kind: "user" })).rejects.toBeInstanceOf(BotConflictError);

  // The whole point of planning before acting: the refusal arrives with the pane still alive and
  // the reference still attached, so the caller can fix the cause and resend the same command.
  expect(endedPanes).toEqual([]);
  expect(await readWorktree(worktree)).not.toBeNull();
  expect((await registry.snapshot()).bots[0]!.sessionRefs).toEqual([ref]);
});

test("a directory that is not a worktree of this Bot's checkout is refused", async () => {
  const { registry } = await fixture();
  const { checkout } = await checkoutWithWorktree();
  const other = await checkoutWithWorktree();
  projects.add(checkout);
  const ref = { source: "claude" as const, sessionId: "elsewhere" };
  // Attaching resolves worktree membership, so point the session at the Bot's own checkout first
  // and move it afterwards: what is under test is the retire-time check, not the attach-time one.
  sessions.set("claude:elsewhere", { projectPath: checkout, summary: summary(ref) });
  const bot = await addBot(registry, { requestId: "add", name: "Repo bot", directoryPath: checkout }, { kind: "user" });
  await addSessions(registry, bot.botId, { requestId: "attach", sessionRefs: [ref] }, { kind: "user" });
  sessions.set("claude:elsewhere", { projectPath: other.worktree, summary: summary(ref) });

  await expect(registry.retireSessions(bot.botId, {
    requestId: "retire",
    sessionRefs: [ref],
    worktree: "remove",
  }, { kind: "user" })).rejects.toBeInstanceOf(BotConflictError);
  expect(await readWorktree(other.worktree)).not.toBeNull();
});

test("refuses a reference the Bot does not hold, and refuses agent actors entirely", async () => {
  const { registry, botId, ref } = await botInWorktree();
  const stranger = { source: "claude" as const, sessionId: "not-mine" };

  await expect(registry.retireSessions(botId, { requestId: "a", sessionRefs: [stranger] }, { kind: "user" }))
    .rejects.toBeInstanceOf(BotNotFoundError);
  await expect(registry.retireSessions("missing-bot", { requestId: "b", sessionRefs: [ref] }, { kind: "user" }))
    .rejects.toBeInstanceOf(BotNotFoundError);
  // Ending somebody's session is further than `add_bot` reaches, exactly as detaching is.
  await expect(registry.retireSessions(botId, { requestId: "c", sessionRefs: [ref] }, { kind: "agent", session: ref }))
    .rejects.toBeInstanceOf(BotForbiddenError);
  expect((await registry.snapshot()).bots[0]!.sessionRefs).toEqual([ref]);
});

test("refuses the disposal pairs git could never carry out", async () => {
  const { registry, botId, ref } = await botInWorktree();

  // A branch cannot be deleted while a worktree has it checked out, so this pair would report a
  // success for a step that never ran.
  await expect(registry.retireSessions(botId, {
    requestId: "a", sessionRefs: [ref], branch: "delete",
  }, { kind: "user" })).rejects.toBeInstanceOf(BotInvalidError);
  // And the local delete is the only merged-ness check there is, so the remote cannot go without it.
  await expect(registry.retireSessions(botId, {
    requestId: "b", sessionRefs: [ref], worktree: "remove", remote: "delete",
  }, { kind: "user" })).rejects.toBeInstanceOf(BotInvalidError);
});

test("a session the catalog has forgotten can be retired, but not have its worktree removed", async () => {
  const { registry, botId, ref } = await botInWorktree();
  sessions.delete("claude:in-worktree");

  await expect(registry.retireSessions(botId, {
    requestId: "a", sessionRefs: [ref], worktree: "remove",
  }, { kind: "user" })).rejects.toBeInstanceOf(BotNotFoundError);

  // Forgetting it is still allowed, for the same reason detaching one is: a row nothing resolves
  // would otherwise be the only row that can never be removed.
  const { bot } = await registry.retireSessions(botId, { requestId: "b", sessionRefs: [ref] }, { kind: "user" });
  expect(bot.sessionRefs).toEqual([]);
});

test("a replayed request ends nothing and removes nothing", async () => {
  const { registry, botId, ref, worktree } = await botInWorktree();
  const command = { requestId: "once", sessionRefs: [ref], worktree: "remove" as const };
  const first = await registry.retireSessions(botId, command, { kind: "user" });
  expect(first.retired[0]!.removedWorktree).toBe(worktree);

  // The pane name is put back to prove the replay does not reach for it: every act here is
  // destructive and none is safe to run twice, since the second would kill whatever pane has since
  // taken that name.
  runningPanes.set(ref.sessionId, "agentdesk-in-worktree");
  const second = await registry.retireSessions(botId, command, { kind: "user" });

  expect(second.retired).toEqual([]);
  expect(second.bot.sessionRefs).toEqual([]);
  expect(endedPanes).toEqual([]);
});
