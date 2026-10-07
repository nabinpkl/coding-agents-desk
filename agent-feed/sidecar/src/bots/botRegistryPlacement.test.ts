// Moving a session to the canvas: onto its directory's Bot, or onto a Bot made for that directory.

import { expect, test } from "bun:test";
import type { BotRecord } from "@agentdesk/agent-feed-wire";
import { BotForbiddenError, BotNotFoundError } from "@/bots/botRegistry";
import { botRegistryHarness } from "@/bots/botRegistryHarness";
import { placementName } from "@/bots/sessions/botSessionPlacement";

const { addBot, checkoutWithWorktree, fixture, projects, sessions, summary } = botRegistryHarness();

const user = { kind: "user" } as const;

test("makes a Bot for a directory that has none, named for it, holding the session", async () => {
  const { registry, project, claudeRef } = await fixture();

  const placed = await registry.placeSession({ requestId: "p1", sessionRef: claudeRef }, user);

  expect(placed.created).toBe(true);
  expect(placed.bot.name).toBe("project");
  expect(placed.bot.environment.path).toBe(project);
  expect(placed.bot.sessions.map((session) => session.sessionId)).toEqual([claudeRef.sessionId]);
});

test("attaches to the Bot the directory already has, and makes no second one", async () => {
  const { registry, project, claudeRef } = await fixture();
  const existing = await addBot(registry, { requestId: "b1", name: "Mine", directoryPath: project }, user);

  const placed = await registry.placeSession({ requestId: "p1", sessionRef: claudeRef }, user);

  expect(placed.created).toBe(false);
  expect(placed.bot.botId).toBe(existing.botId);
  expect(placed.bot.sessions.map((session) => session.sessionId)).toEqual([claudeRef.sessionId]);
  expect((await registry.snapshot()).bots).toHaveLength(1);
});

test("puts a worktree's session on its checkout's Bot", async () => {
  const { registry } = await fixture();
  const { checkout, worktree } = await checkoutWithWorktree();
  projects.add(checkout);
  const ref = { source: "claude" as const, sessionId: "in-worktree" };
  sessions.set("claude:in-worktree", { projectPath: worktree, summary: summary(ref) });
  const existing = await addBot(registry, { requestId: "b1", name: "Repo", directoryPath: checkout }, user);

  const placed = await registry.placeSession({ requestId: "p1", sessionRef: ref }, user);

  expect(placed).toMatchObject({ created: false, bot: { botId: existing.botId } });
});

test("binds a Bot made for a worktree's session to the checkout, not the worktree", async () => {
  const { registry } = await fixture();
  const { checkout, worktree } = await checkoutWithWorktree();
  projects.add(checkout);
  const ref = { source: "claude" as const, sessionId: "in-worktree" };
  sessions.set("claude:in-worktree", { projectPath: worktree, summary: summary(ref) });

  const placed = await registry.placeSession({ requestId: "p1", sessionRef: ref }, user);

  expect(placed.created).toBe(true);
  expect(placed.bot.environment.path).toBe(checkout);
  expect(placed.bot.name).toBe("checkout");
});

test("names a Bot after the parent folder too when another Bot has the directory's name", async () => {
  const { registry, secondProject, claudeRef } = await fixture();
  await addBot(registry, { requestId: "b1", name: "project", directoryPath: secondProject }, user);

  const placed = await registry.placeSession({ requestId: "p1", sessionRef: claudeRef }, user);

  expect(placed.bot.name).toMatch(/^project \(agentdesk-bots-registry-.+\)$/);
});

test("a replayed placement makes nothing twice", async () => {
  const { registry, claudeRef } = await fixture();

  await registry.placeSession({ requestId: "p1", sessionRef: claudeRef }, user);
  const again = await registry.placeSession({ requestId: "p1", sessionRef: claudeRef }, user);

  expect(again.created).toBe(false);
  const { bots } = await registry.snapshot();
  expect(bots).toHaveLength(1);
  expect(bots[0]!.sessionRefs).toEqual([claudeRef]);
});

test("answers with the Bot that already holds the session, wherever it is bound", async () => {
  const { registry, project, claudeRef } = await fixture();
  const first = await registry.placeSession({ requestId: "p1", sessionRef: claudeRef }, user);
  expect(first.bot.environment.path).toBe(project);

  const second = await registry.placeSession({ requestId: "p2", sessionRef: claudeRef }, user);

  expect(second).toMatchObject({ created: false, bot: { botId: first.bot.botId } });
});

test("refuses an agent, and a session the catalog does not have", async () => {
  const { registry, claudeRef } = await fixture();

  await expect(
    registry.placeSession({ requestId: "p1", sessionRef: claudeRef }, { kind: "agent", session: claudeRef }),
  ).rejects.toBeInstanceOf(BotForbiddenError);
  await expect(
    registry.placeSession({ requestId: "p2", sessionRef: { source: "claude", sessionId: "gone" } }, user),
  ).rejects.toBeInstanceOf(BotNotFoundError);
  expect((await registry.snapshot()).bots).toEqual([]);
});

test("numbers a name once the directory's name and its parent's are both taken", () => {
  const bots = [{ name: "web" }, { name: "Web (apps)" }] as BotRecord[];
  expect(placementName("/home/me/apps/web", bots, 64)).toBe("web (apps) 2");
  expect(placementName("/home/me/apps/api", bots, 64)).toBe("api");
});
