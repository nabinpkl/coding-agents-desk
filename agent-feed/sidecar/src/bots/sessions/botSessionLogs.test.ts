// The agent log a session states it keeps (ADR-0147): what is accepted, what is refused, and how a
// handover carries it.
import { expect, test } from "bun:test";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { botRegistryHarness } from "@/bots/botRegistryHarness";
import { BotStore } from "@/bots/botStore";
import { isAgentLogPath, normalizeLogPath } from "@/bots/sessions/botSessionLogs";

const { addBot, addSessions, fixture } = botRegistryHarness();

const LOG = ".agents/agents-log/lint-manager.log";

async function writeLog(directory: string, path = LOG): Promise<void> {
  await mkdir(join(directory, ".agents", "agents-log"), { recursive: true });
  await writeFile(join(directory, path), "2026-10-19  lint   a line | a reason\n");
}

async function attachedFixture() {
  const world = await fixture();
  const bot = await addBot(
    world.registry,
    { requestId: "add", name: "Captain", directoryPath: world.project },
    { kind: "user" },
  );
  await addSessions(world.registry, bot.botId, { requestId: "attach", sessionRefs: [world.ref] }, { kind: "user" });
  return { ...world, botId: bot.botId };
}

test("a log path is relative, under the log directory, named .log, with no way out", () => {
  expect(isAgentLogPath(LOG)).toBe(true);
  expect(isAgentLogPath(".agents/agents-log/nested/area.log")).toBe(true);
  for (const refused of [
    "/abs/.agents/agents-log/x.log",
    ".agents/agents-log/../../etc/x.log",
    ".agents/agents-log/./x.log",
    ".agents/agents-log//x.log",
    ".agents/agents-log/x.txt",
    ".agents/agents-log/.log",
    ".agents/other/x.log",
    ".agents\\agents-log\\x.log",
    ".agents/agents-log/x\n.log",
    `.agents/agents-log/${"a".repeat(300)}.log`,
    42,
  ]) {
    expect(isAgentLogPath(refused)).toBe(false);
  }
  expect(normalizeLogPath(`  ${LOG} `)).toBe(LOG);
  expect(() => normalizeLogPath("README.md")).toThrow(/agents-log/);
  expect(() => normalizeLogPath(undefined)).toThrow(/must be a string/);
});

test("a session registers its log once, and a repeat writes nothing", async () => {
  const { project, ref, registry, store, botId } = await attachedFixture();
  await writeLog(project);

  expect(await registry.registerSessionLog(ref, LOG)).toEqual({ botId, path: LOG, status: "registered" });
  const revision = (await store.snapshot()).revision;
  expect(await registry.registerSessionLog(ref, LOG)).toEqual({ botId, path: LOG, status: "already" });
  expect((await store.snapshot()).revision).toBe(revision);

  const view = (await registry.snapshot()).bots.find((bot) => bot.botId === botId)!;
  expect(view.sessionLogs).toEqual({ "pi:session-1": LOG });

  // One log per session: stating another replaces the first.
  const other = ".agents/agents-log/tests-manager.log";
  await writeLog(project, other);
  expect((await registry.registerSessionLog(ref, other)).status).toBe("registered");
  expect((await store.snapshot()).bots[0]!.sessionLogs).toEqual({ "pi:session-1": other });
});

test("registration refuses a session no Bot holds, a missing file, and a symlink out", async () => {
  const world = await fixture();
  await writeLog(world.project);
  await expect(world.registry.registerSessionLog(world.ref, LOG)).rejects.toThrow(/not attached to any Bot/);

  const { project, ref, registry } = await attachedFixture();
  await expect(registry.registerSessionLog(ref, ".agents/agents-log/absent.log")).rejects.toThrow(/no file/);

  const outside = join(project, "..", "outside.log");
  await writeFile(outside, "not a log of this Bot\n");
  await mkdir(join(project, ".agents", "agents-log"), { recursive: true });
  await symlink(outside, join(project, ".agents", "agents-log", "escape.log"));
  await expect(registry.registerSessionLog(ref, ".agents/agents-log/escape.log")).rejects.toThrow(/no file/);
});

test("a handover's successor is given the log its predecessor kept", async () => {
  const { project, ref, registry, store, botId } = await attachedFixture();
  await writeLog(project);
  await registry.registerSessionLog(ref, LOG);

  const successor = { source: "claude" as const, sessionId: "successor-1" };
  await registry.carrySessionLog(ref, successor);
  const bot = (await store.snapshot()).bots.find((one) => one.botId === botId)!;
  expect(bot.sessionLogs).toEqual({ "pi:session-1": LOG, "claude:successor-1": LOG });

  // Nothing to carry writes nothing.
  const revision = (await store.snapshot()).revision;
  await registry.carrySessionLog({ source: "claude", sessionId: "never-logged" }, successor);
  await registry.carrySessionLog(ref, successor);
  expect((await store.snapshot()).revision).toBe(revision);
});

test("bots.json loads a stored log and refuses one that points out of the log directory", async () => {
  const { project, ref, registry } = await attachedFixture();
  await writeLog(project);
  await registry.registerSessionLog(ref, LOG);
  // The harness keeps bots.json beside the project.
  const path = join(project, "..", "bots.json");
  expect((await new BotStore(path).snapshot()).bots[0]!.sessionLogs).toEqual({ "pi:session-1": LOG });

  const stored = JSON.parse(await readFile(path, "utf8")) as { bots: { sessionLogs: Record<string, string> }[] };
  stored.bots[0]!.sessionLogs = { "pi:session-1": "../secrets.log" };
  await writeFile(path, JSON.stringify(stored));
  await expect(new BotStore(path).snapshot()).rejects.toThrow(/invalid Bot record/);
});
