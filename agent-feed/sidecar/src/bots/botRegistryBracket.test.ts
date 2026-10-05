// One session's bracket task: the anchor is resolved from the store, the rename goes through the
// injected mechanism, and a session no single Bot holds is refused by name.
import { expect, test } from "bun:test";
import { botRegistryHarness } from "@/bots/botRegistryHarness";

const { addBot, addSessions, fixture, sessions, summary } = botRegistryHarness();

test("renameBracket resolves the anchor and renames through the injected mechanism", async () => {
  const { project, ref, registry } = await fixture();
  const bot = await addBot(registry, { requestId: "add", name: "Captain", directoryPath: project }, { kind: "user" });
  await addSessions(registry, bot.botId, { requestId: "attach", sessionRefs: [ref] }, { kind: "user" });

  const renamed: { ref: { source: string; sessionId: string }; title: string }[] = [];
  const done = await registry.renameBracket(ref, "night shift", async (at, title) => {
    renamed.push({ ref: at, title });
  });
  expect(done).toEqual({ botId: bot.botId, anchor: "Aaron", title: "Aaron (night shift)", status: "renamed" });
  expect(renamed).toEqual([{ ref, title: "Aaron (night shift)" }]);
});

test("renameBracket answers already when the title is wearing it", async () => {
  const { project, ref, registry } = await fixture();
  sessions.set("pi:session-1", {
    projectPath: project,
    summary: { ...summary(ref), title: "Aaron (night shift)" },
  });
  const bot = await addBot(registry, { requestId: "add", name: "Captain", directoryPath: project }, { kind: "user" });
  await addSessions(registry, bot.botId, { requestId: "attach", sessionRefs: [ref] }, { kind: "user" });
  // Anchor spent at attach, so no reservation is left to do: the stored name answers.
  const stored = (await registry.snapshot()).bots.find((one) => one.botId === bot.botId)!;
  expect(stored.sessionAnchors).toEqual({ "pi:session-1": "Aaron" });

  let calls = 0;
  const done = await registry.renameBracket(ref, "night shift", async () => { calls += 1; });
  expect(done.status).toBe("already");
  expect(calls).toBe(0);
});

test("renameBracket refuses a session no Bot holds, one two Bots hold, and a bad task", async () => {
  const { project, ref, secondProject, registry } = await fixture();
  const bot = await addBot(registry, { requestId: "add", name: "Captain", directoryPath: project }, { kind: "user" });
  // A session in no Bot at all.
  await expect(registry.renameBracket(ref, "x", async () => {})).rejects.toThrow(/not attached to any Bot/);

  await addSessions(registry, bot.botId, { requestId: "attach", sessionRefs: [ref] }, { kind: "user" });
  await expect(registry.renameBracket(ref, "has (parens)", async () => {})).rejects.toThrow(/parentheses/);

  // A session held twice over has two anchors and one title cannot wear both. Moved into the
  // second Bot's directory after the first attach, so both Bots may claim it.
  sessions.set("pi:session-1", { projectPath: secondProject, summary: summary(ref) });
  const other = await addBot(
    registry,
    { requestId: "add-2", name: "Second", directoryPath: secondProject },
    { kind: "user" },
  );
  await addSessions(registry, other.botId, { requestId: "attach-2", sessionRefs: [ref] }, { kind: "user" });
  await expect(registry.renameBracket(ref, "x", async () => {})).rejects.toThrow(/held by "Captain" and "Second"/);
});
