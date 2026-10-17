// Starting a session for a Bot: what the launcher is asked for, what a replayed request
// answers, and what is left behind when the launch fails.

import { expect, test } from "bun:test";
import { BotForbiddenError, BotLaunchError, type BotSessionLauncher } from "@/bots/botRegistry";
import { botRegistryHarness, type LaunchRecord } from "@/bots/botRegistryHarness";

const { addBot, addSessions, fixture, projects, recordingLauncher, sessions, summary, temporaryDirectories } = botRegistryHarness();

test("creating a Bot with launch starts a session in its directory and attaches it", async () => {
  const { launched, launcher } = recordingLauncher();
  const { project, registry } = await fixture(launcher);

  const bot = await addBot(registry, {
    requestId: "request-1",
    name: "OSS agent",
    directoryPath: project,
    launch: { prompt: "Familiarize yourself with the repo." },
  }, { kind: "user" });

  // The title is the first free anchor, bare: names come from the pool, never from the Bot.
  expect(launched).toEqual([{
    kind: "start",
    cwd: project,
    sessionId: "started-1",
    title: "Aaron",
    prompt: "Familiarize yourself with the repo.",
  }]);
  expect(bot.sessionRefs).toEqual([{ source: "claude", sessionId: "started-1" }]);
  // Not in `sessions` yet: the catalog cannot resolve a session whose transcript does not exist,
  // and saying so is more honest than pretending it is live.
  expect(bot.sessions).toEqual([]);
  expect(bot.missingSessionRefs).toEqual([{ source: "claude", sessionId: "started-1" }]);
});

test("a launch title brackets as the task after the allocated anchor, and a prompt is optional", async () => {
  const { launched, launcher } = recordingLauncher();
  const { project, registry } = await fixture(launcher);

  await addBot(registry, {
    requestId: "request-1",
    name: "OSS agent",
    directoryPath: project,
    launch: { title: "familiarization" },
  }, { kind: "user" });

  // The anchor is stable and the request is the bracket: the `-n` name is both halves at once.
  expect(launched).toEqual([{
    kind: "start",
    cwd: project,
    sessionId: "started-1",
    title: "Aaron (familiarization)",
    prompt: undefined,
  }]);
});

test("a launch can ask for SDK mode, and only for a fresh session", async () => {
  const { launched, launcher } = recordingLauncher();
  const { project, registry } = await fixture(launcher);

  await addBot(registry, {
    requestId: "request-1",
    name: "OSS agent",
    directoryPath: project,
    launch: { title: "probe", claudeMode: "sdk" },
  }, { kind: "user" });
  expect(launched).toEqual([{
    kind: "start",
    cwd: project,
    sessionId: "started-1",
    title: "Aaron (probe)",
    prompt: undefined,
    mode: "sdk",
  }]);

  await expect(addBot(registry, {
    requestId: "request-2",
    name: "Other",
    directoryPath: project,
    launch: { claudeMode: "headless" as "sdk" },
  }, { kind: "user" })).rejects.toThrow(/terminal or sdk/);
  await expect(addBot(registry, {
    requestId: "request-3",
    name: "Third",
    directoryPath: project,
    launch: { claudeMode: "sdk", from: { source: "claude", sessionId: "started-1" } },
  }, { kind: "user" })).rejects.toThrow(/fork starts in the terminal/);
  expect(launched).toHaveLength(1);
});

test("replaying a launch request returns the same Bot without starting a second session", async () => {
  const { launched, launcher } = recordingLauncher();
  const { project, registry } = await fixture(launcher);
  const command = {
    requestId: "request-1",
    name: "OSS agent",
    directoryPath: project,
    launch: { prompt: "Read AGENTS.md." },
  } as const;

  const first = await addBot(registry, command, { kind: "user" });
  const replay = await addBot(registry, command, { kind: "user" });

  expect(replay.botId).toBe(first.botId);
  expect(replay.sessionRefs).toEqual(first.sessionRefs);
  expect(launched).toHaveLength(1);
});

test("a launch failure leaves the Bot behind and says so", async () => {
  const { launched, launcher } = recordingLauncher(new Error("tmux is not installed"));
  const { project, registry } = await fixture(launcher);

  await expect(addBot(registry, {
    requestId: "request-1",
    name: "OSS agent",
    directoryPath: project,
    launch: {},
  }, { kind: "user" })).rejects.toBeInstanceOf(BotLaunchError);

  expect(launched).toHaveLength(1);
  const snapshot = await registry.snapshot();
  // The Bot survives, with nothing attached: a retry of the same command would collide with it,
  // so the error has to be the thing that says the name is now taken.
  expect(snapshot.bots.map((bot) => [bot.name, bot.sessionRefs])).toEqual([["OSS agent", []]]);
});

test("an agent may add a Bot but may not start a session for it", async () => {
  const { launched, launcher } = recordingLauncher();
  const { project, ref, registry } = await fixture(launcher);
  await addBot(registry, {
    requestId: "request-1",
    name: "Owner",
    directoryPath: project,
    grants: ["add_bot"],
  }, { kind: "user" });
  await addSessions(registry, "bot-1", { requestId: "attach-1", sessionRefs: [ref] }, { kind: "user" });

  await expect(addBot(registry, {
    requestId: "request-2",
    name: "Spawned",
    directoryPath: project,
    launch: { prompt: "do the thing" },
  }, { kind: "agent", session: ref })).rejects.toBeInstanceOf(BotForbiddenError);

  expect(launched).toEqual([]);
});

test("refuses a launch title that would not survive being one argument", async () => {
  const { launched, launcher } = recordingLauncher();
  const { project, registry } = await fixture(launcher);

  await expect(addBot(registry, {
    requestId: "request-1",
    name: "OSS agent",
    directoryPath: project,
    launch: { title: "line\nbreak" },
  }, { kind: "user" })).rejects.toThrow(/line break/);

  expect(launched).toEqual([]);
  expect((await registry.snapshot()).bots).toEqual([]);
});

test("resending a request whose launch failed starts the session it still owes", async () => {
  const failure = new Error("tmux is not installed");
  const launched: LaunchRecord[] = [];
  let broken = true;
  const launcher: BotSessionLauncher = {
    async start(options) {
      launched.push({ kind: "start", ...options });
      if (broken) throw failure;
      return { tmuxSession: `agentdesk-${options.sessionId}` };
    },
    fork: async () => { throw new Error("unreached"); },
    end: async () => null,
  };
  const { project, registry } = await fixture(launcher);
  const command = {
    requestId: "request-1",
    name: "OSS agent",
    directoryPath: project,
    launch: { prompt: "Read AGENTS.md." },
  } as const;

  await expect(addBot(registry, command, { kind: "user" })).rejects.toBeInstanceOf(BotLaunchError);
  broken = false;
  const recovered = await addBot(registry, command, { kind: "user" });

  expect(launched).toHaveLength(2);
  expect(recovered.sessionRefs).toEqual([{ source: "claude", sessionId: "started-2" }]);
  // Still one Bot: the replay finished the command rather than making a second.
  expect((await registry.snapshot()).bots).toHaveLength(1);
});
