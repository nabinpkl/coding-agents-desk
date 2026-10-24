// Where a Bot's session came from: what a handover records, and what bots.json accepts back.
// A fork's origin is written by its launch, and `botRegistryLaunch.test.ts` checks it there.
import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { botRegistryHarness } from "@/bots/botRegistryHarness";
import { BotStore } from "@/bots/botStore";

const { addBot, addSessions, fixture } = botRegistryHarness();

test("a handover marks its successor on the Bot that holds its source, and nowhere else", async () => {
  const { project, ref, registry, store } = await fixture();
  const bot = await addBot(registry, { requestId: "add", name: "Captain", directoryPath: project }, { kind: "user" });
  await addSessions(registry, bot.botId, { requestId: "attach", sessionRefs: [ref] }, { kind: "user" });
  const successor = { source: "opencode" as const, sessionId: "ses_successor" };

  // A source no Bot holds has no Bot to mark the successor on, so nothing is written.
  const revision = (await store.snapshot()).revision;
  await registry.recordHandoverOrigin({ source: "claude", sessionId: "held-by-nobody" }, successor);
  expect((await store.snapshot()).revision).toBe(revision);

  // Written ahead of the successor's attach, which the panel makes for this direction.
  await registry.recordHandoverOrigin(ref, successor);
  const view = (await registry.snapshot()).bots.find((one) => one.botId === bot.botId)!;
  expect(view.sessionOrigins).toEqual({ "opencode:ses_successor": { kind: "handover", from: ref } });

  // The harness keeps bots.json beside the project.
  const path = join(project, "..", "bots.json");
  expect((await new BotStore(path).snapshot()).bots[0]!.sessionOrigins).toEqual(view.sessionOrigins);
  const stored = JSON.parse(await readFile(path, "utf8")) as { bots: { sessionOrigins: Record<string, unknown> }[] };
  stored.bots[0]!.sessionOrigins = { "opencode:ses_successor": { kind: "copy", from: ref } };
  await writeFile(path, JSON.stringify(stored));
  await expect(new BotStore(path).snapshot()).rejects.toThrow(/invalid Bot record/);
});
