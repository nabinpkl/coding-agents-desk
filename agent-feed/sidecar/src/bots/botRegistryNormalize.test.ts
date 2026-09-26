// The normalize-titles pass: every attached session ends up under a spent anchor, and the
// response says what each one got rather than failing the ones that could not move.
import { expect, test } from "bun:test";
import type { BotSessionRef } from "@agentdesk/agent-feed-wire";
import { botRegistryHarness } from "@/bots/botRegistryHarness";

const { addBot, addSessions, fixture, sessions, summary } = botRegistryHarness();

test("spends anchors in order and renames every session it can", async () => {
  const { project, ref, secondRef, claudeRef, registry } = await fixture();
  sessions.set("pi:session-1", {
    projectPath: project,
    summary: { ...summary(ref), title: "Windows canvas" },
  });
  sessions.set("codex:session-2", {
    projectPath: project,
    summary: { ...summary(secondRef), title: "Windows canvas (fork 1)" },
  });
  const bot = await addBot(registry, { requestId: "add", name: "Captain", directoryPath: project }, { kind: "user" });
  await addSessions(registry, bot.botId, { requestId: "attach", sessionRefs: [ref, secondRef, claudeRef] }, { kind: "user" });

  const renamed: { ref: BotSessionRef; title: string }[] = [];
  const { bots, normalizations } = await registry.normalizeTitles(async (at, title) => {
    renamed.push({ ref: at, title });
  });

  // Spent in attach order, first-free across the run: Aaron, Adam, Alan.
  expect(renamed).toEqual([
    { ref, title: "Aaron (Windows canvas)" },
    { ref: secondRef, title: "Adam (Windows canvas)" },
    { ref: claudeRef, title: "Alan (claude session)" },
  ]);
  expect(normalizations.every((one) => one.status === "renamed")).toBe(true);
  const view = bots.find((one) => one.botId === bot.botId)!;
  expect(view.sessionAnchors).toEqual({
    "pi:session-1": "Aaron",
    "codex:session-2": "Adam",
    "claude:session-3": "Alan",
  });
});

test("a second pass renames nothing and spends nothing new", async () => {
  const { project, ref, registry } = await fixture();
  const bot = await addBot(registry, { requestId: "add", name: "Captain", directoryPath: project }, { kind: "user" });
  await addSessions(registry, bot.botId, { requestId: "attach", sessionRefs: [ref] }, { kind: "user" });

  let calls = 0;
  const renamer = async (at: BotSessionRef, title: string) => {
    calls += 1;
    sessions.set(`${at.source}:${at.sessionId}`, {
      projectPath: project,
      summary: { ...summary(at), title },
    });
  };
  const first = await registry.normalizeTitles(renamer);
  expect(first.normalizations).toEqual([{
    botId: bot.botId,
    source: "pi",
    sessionId: "session-1",
    anchor: "Aaron",
    title: "Aaron (pi session)",
    status: "renamed",
  }]);
  const second = await registry.normalizeTitles(renamer);
  expect(second.normalizations.map((one) => one.status)).toEqual(["already"]);
  expect(calls).toBe(1);
});

test("one stuck session reports instead of stopping the pass", async () => {
  const { project, ref, secondRef, registry } = await fixture();
  const bot = await addBot(registry, { requestId: "add", name: "Captain", directoryPath: project }, { kind: "user" });
  await addSessions(registry, bot.botId, { requestId: "attach", sessionRefs: [ref, secondRef] }, { kind: "user" });
  sessions.delete("codex:session-2");

  const { normalizations } = await registry.normalizeTitles(async () => {});
  expect(normalizations).toEqual([
    {
      botId: bot.botId,
      source: "pi",
      sessionId: "session-1",
      anchor: "Aaron",
      title: "Aaron (pi session)",
      status: "renamed",
    },
    {
      botId: bot.botId,
      source: "codex",
      sessionId: "session-2",
      anchor: "Adam",
      title: "Adam",
      status: "skipped",
      reason: "not in the catalog",
    },
  ]);
  // The skipped session keeps its anchor: the retry reuses the name rather than spending one.
  const view = (await registry.snapshot()).bots.find((one) => one.botId === bot.botId)!;
  expect(view.sessionAnchors).toEqual({ "pi:session-1": "Aaron", "codex:session-2": "Adam" });
});

test("a task that cannot bracket starts bare and says what was left behind", async () => {
  const { project, ref, registry } = await fixture();
  sessions.set("pi:session-1", {
    projectPath: project,
    summary: { ...summary(ref), title: "fix (urgent) bug" },
  });
  const bot = await addBot(registry, { requestId: "add", name: "Captain", directoryPath: project }, { kind: "user" });
  await addSessions(registry, bot.botId, { requestId: "attach", sessionRefs: [ref] }, { kind: "user" });

  const { normalizations } = await registry.normalizeTitles(async () => {});
  expect(normalizations).toEqual([{
    botId: bot.botId,
    source: "pi",
    sessionId: "session-1",
    anchor: "Aaron",
    title: "Aaron",
    status: "renamed",
    reason: `task "fix (urgent) bug" cannot bracket, starting bare`,
  }]);
});

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
