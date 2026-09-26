// Renaming, restyling, naming a Father, and forgetting a Bot: the record with the named
// fields replaced and everything else kept, or gone with its sessions surviving.

import { describe, expect, test } from "bun:test";
import { BotConflictError, BotForbiddenError, BotInvalidError, BotNotFoundError } from "@/bots/botTypes";
import { botRegistryHarness } from "@/bots/botRegistryHarness";

const { addBot, addSessions, fixture } = botRegistryHarness();
const user = { kind: "user" } as const;
const agent = { kind: "agent", session: { source: "pi", sessionId: "session-1" } } as const;

async function botWithSession() {
  const { project, ref, registry } = await fixture();
  const bot = await addBot(registry, {
    requestId: "create-1",
    name: "Captain",
    directoryPath: project,
  }, user);
  const withSession = await addSessions(registry, bot.botId, {
    requestId: "attach-1",
    sessionRefs: [ref],
  }, user);
  return { project, ref, registry, bot: withSession };
}

describe("updateBot", () => {
  test("renames and restyles, leaving the directory, sessions and grants alone", async () => {
    const { registry, bot, ref } = await botWithSession();
    const updated = await registry.updateBot(bot.botId, {
      name: "Commodore",
      iconUrl: "https://example.com/commodore.png",
      metadata: { role: "Runs the strip" },
    }, user);
    expect(updated.name).toBe("Commodore");
    expect(updated.iconUrl).toBe("https://example.com/commodore.png");
    expect(updated.metadata.role).toBe("Runs the strip");
    expect(updated.environment.path).toBe(bot.environment.path);
    expect(updated.sessionRefs).toEqual([ref]);
    expect(updated.grants).toEqual(bot.grants);
  });

  test("clears an icon and a role with an emptied field, and refuses an empty call", async () => {
    const { registry, bot } = await botWithSession();
    const styled = await registry.updateBot(bot.botId, {
      iconUrl: "https://example.com/x.png",
      metadata: { role: "Runs the strip" },
    }, user);
    expect(styled.iconUrl).toBe("https://example.com/x.png");
    const cleared = await registry.updateBot(bot.botId, { iconUrl: "", metadata: { role: "" } }, user);
    expect("iconUrl" in cleared).toBe(false);
    expect(cleared.metadata.role).toBeUndefined();
    await expect(registry.updateBot(bot.botId, {}, user)).rejects.toBeInstanceOf(BotInvalidError);
  });

  test("refuses a sibling's name and a malformed icon, and lets a Bot keep its own", async () => {
    const { project, secondProject, registry } = await fixture();
    const first = await addBot(registry, { requestId: "a", name: "Captain", directoryPath: project }, user);
    await addBot(registry, { requestId: "b", name: "Sweeper", directoryPath: secondProject }, user);
    await expect(registry.updateBot(first.botId, { name: "sweeper" }, user))
      .rejects.toBeInstanceOf(BotConflictError);
    const kept = await registry.updateBot(first.botId, { name: "Captain" }, user);
    expect(kept.name).toBe("Captain");
    await expect(registry.updateBot(first.botId, { iconUrl: "http://plain/icon.png" }, user))
      .rejects.toBeInstanceOf(BotInvalidError);
  });

  test("names a Father it holds, clears it on null, and refuses one it does not", async () => {
    const { registry, bot, ref } = await botWithSession();
    const named = await registry.updateBot(bot.botId, { fatherSession: ref }, user);
    expect(named.fatherSession).toEqual(ref);
    const cleared = await registry.updateBot(bot.botId, { fatherSession: null }, user);
    expect("fatherSession" in cleared).toBe(false);
    await expect(registry.updateBot(bot.botId, {
      fatherSession: { source: "claude", sessionId: "stranger" },
    }, user)).rejects.toBeInstanceOf(BotNotFoundError);
  });

  test("detaching the Father clears it in the same write", async () => {
    const { registry, bot, ref } = await botWithSession();
    await registry.updateBot(bot.botId, { fatherSession: ref }, user);
    const detached = await registry.detachSessions(bot.botId, {
      requestId: "detach-1",
      sessionRefs: [ref],
    }, user);
    expect("fatherSession" in detached).toBe(false);
    expect(detached.sessionRefs).toEqual([]);
  });

  test("refuses an agent actor and an unknown Bot", async () => {
    const { registry, bot } = await botWithSession();
    await expect(registry.updateBot(bot.botId, { name: "X" }, agent))
      .rejects.toBeInstanceOf(BotForbiddenError);
    await expect(registry.updateBot("no-such-bot", { name: "X" }, user))
      .rejects.toBeInstanceOf(BotNotFoundError);
  });
});

describe("deleteBot", () => {
  test("forgets the record and prunes its ledger, and a second call says gone", async () => {
    const { project, secondProject, registry } = await fixture();
    const first = await addBot(registry, { requestId: "a", name: "Captain", directoryPath: project }, user);
    await addBot(registry, { requestId: "b", name: "Sweeper", directoryPath: secondProject }, user);
    // A ledger entry pointing at the deleted Bot fails the snapshot's own validation on the
    // next read, so the delete must take its entries with it.
    const deleted = await registry.deleteBot(first.botId, user);
    expect(deleted).toEqual({ deleted: first.botId });
    const snapshot = await registry.snapshot();
    expect(snapshot.bots.map((bot) => bot.botId)).toEqual(["bot-2"]);
    await expect(registry.deleteBot(first.botId, user)).rejects.toBeInstanceOf(BotNotFoundError);
  });

  test("leaves the sessions in the catalog: forgetting, not ending", async () => {
    const { project, ref, registry, bot } = await botWithSession();
    await registry.deleteBot(bot.botId, user);
    expect((await registry.snapshot()).bots).toEqual([]);
    // The transcript is still there to attach elsewhere: the Bot never owned it.
    const other = await addBot(registry, { requestId: "c", name: "Second", directoryPath: project }, user);
    const reattached = await addSessions(registry, other.botId, {
      requestId: "d",
      sessionRefs: [ref],
    }, user);
    expect(reattached.sessionRefs).toEqual([ref]);
  });

  test("refuses an agent actor, an unknown Bot, and a malformed id", async () => {
    const { registry, bot } = await botWithSession();
    await expect(registry.deleteBot(bot.botId, agent)).rejects.toBeInstanceOf(BotForbiddenError);
    await expect(registry.deleteBot("no-such-bot", user)).rejects.toBeInstanceOf(BotNotFoundError);
    await expect(registry.deleteBot("not an id!", user)).rejects.toBeInstanceOf(BotInvalidError);
  });
});
