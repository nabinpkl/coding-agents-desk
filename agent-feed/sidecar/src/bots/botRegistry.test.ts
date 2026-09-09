import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BotSessionRef, SessionSummary } from "@agentdesk/agent-feed-wire";
import { BotStore } from "./botStore.ts";
import {
  BotConflictError,
  BotForbiddenError,
  BotLaunchError,
  BotNotFoundError,
  BotRegistry,
  type BotRegistryCatalog,
  type BotSessionLauncher,
} from "./botRegistry.ts";

const temporaryDirectories: string[] = [];
const projects = new Set<string>();
const sessions = new Map<string, { projectPath: string; summary: SessionSummary }>();
const listeners = new Set<() => void>();

const catalog: BotRegistryCatalog = {
  resolveProject(path) {
    return projects.has(path) ? { projectPath: path } : undefined;
  },
  resolveSession(ref) {
    return sessions.get(`${ref.source}:${ref.sessionId}`);
  },
  subscribe(listener) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

afterEach(async () => {
  projects.clear();
  sessions.clear();
  listeners.clear();
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function summary(ref: BotSessionRef, canSend = true): SessionSummary {
  return {
    ...ref,
    title: `${ref.source} session`,
    lastEventAt: 1,
    activity: "ready",
    capabilities: {
      modes: ["nice"],
      canSend,
      canSteer: canSend,
      canAbort: canSend,
      canFetchRaw: false,
      canOpenTerminal: false,
      supportsExtensionUi: false,
      canStreamLive: false,
    },
  };
}

interface LaunchRecord {
  cwd: string;
  sessionId: string;
  title: string;
  prompt?: string;
}

/** Records what would have been started, so the sequence around it can be checked without tmux. */
function recordingLauncher(fail?: Error): { launched: LaunchRecord[]; launcher: BotSessionLauncher } {
  const launched: LaunchRecord[] = [];
  return {
    launched,
    launcher: {
      async start(options) {
        launched.push({ ...options });
        if (fail) throw fail;
        return options;
      },
    },
  };
}

async function fixture(launcher?: BotSessionLauncher) {
  const directory = await mkdtemp(join(tmpdir(), "agentdesk-bots-registry-"));
  temporaryDirectories.push(directory);
  const project = join(directory, "project");
  const secondProject = join(directory, "second-project");
  await Promise.all([mkdir(project), mkdir(secondProject)]);
  projects.add(project);
  projects.add(secondProject);
  const ref = { source: "pi" as const, sessionId: "session-1" };
  const secondRef = { source: "codex" as const, sessionId: "session-2" };
  sessions.set("pi:session-1", { projectPath: project, summary: summary(ref) });
  sessions.set("codex:session-2", { projectPath: project, summary: summary(secondRef, false) });
  let nextId = 0;
  let nextSessionId = 0;
  return {
    project,
    secondProject,
    ref,
    secondRef,
    registry: new BotRegistry(
      new BotStore(join(directory, "bots.json")),
      catalog,
      () => 123,
      () => `bot-${++nextId}`,
      launcher ?? { start: async () => undefined },
      () => `started-${++nextSessionId}`,
    ),
  };
}

test("adds a user-facing Bot for an existing project directory with no sessions", async () => {
  const { project, registry } = await fixture();
  const bot = await registry.add({
    requestId: "request-1",
    name: "Release Captain",
    iconUrl: "https://example.com/captain.png",
    directoryPath: project,
    metadata: { role: "Own releases", labels: ["release"], custom: { team: "platform" } },
    grants: ["add_bot"],
  }, { kind: "user" });

  expect(bot).toMatchObject({
    botId: "bot-1",
    name: "Release Captain",
    iconUrl: "https://example.com/captain.png",
    environment: { kind: "directory", path: project },
    sessionRefs: [],
    sessions: [],
    missingSessionRefs: [],
    metadata: { role: "Own releases", labels: ["release"], custom: { team: "platform" } },
    grants: ["add_bot"],
    createdBy: { kind: "user" },
    environmentAvailability: "available",
  });
});

test("retries add idempotently and enforces unique names and directories", async () => {
  const { project, secondProject, registry } = await fixture();
  const command = { requestId: "same", name: "Captain", directoryPath: project };
  const first = await registry.add(command, { kind: "user" });
  expect((await registry.add(command, { kind: "user" })).botId).toBe(first.botId);
  await expect(registry.add({ ...command, name: "Different" }, { kind: "user" }))
    .rejects.toBeInstanceOf(BotConflictError);
  await expect(registry.add({ requestId: "two", name: "captain", directoryPath: secondProject }, { kind: "user" }))
    .rejects.toBeInstanceOf(BotConflictError);
  await expect(registry.add({ requestId: "three", name: "Reviewer", directoryPath: project }, { kind: "user" }))
    .rejects.toBeInstanceOf(BotConflictError);
});

test("attaches existing sessions from the Bot directory as one durable update", async () => {
  const { project, ref, secondRef, registry } = await fixture();
  const bot = await registry.add({ requestId: "add", name: "Captain", directoryPath: project }, { kind: "user" });
  const command = { requestId: "attach", sessionRefs: [ref, secondRef] };
  const attached = await registry.attachSessions(bot.botId, command, { kind: "user" });

  expect(attached.sessionRefs).toEqual([ref, secondRef]);
  expect(attached.sessions).toEqual([summary(ref), summary(secondRef, false)]);
  expect((await registry.attachSessions(bot.botId, command, { kind: "user" })).sessionRefs).toEqual([ref, secondRef]);
  expect((await registry.snapshot()).revision).toBe(2);
});

test("rejects sessions outside the Bot directory and request reuse across Bots", async () => {
  const { project, secondProject, ref, registry } = await fixture();
  const first = await registry.add({ requestId: "first", name: "First", directoryPath: project }, { kind: "user" });
  const second = await registry.add({ requestId: "second", name: "Second", directoryPath: secondProject }, { kind: "user" });

  await expect(registry.attachSessions(second.botId, { requestId: "outside", sessionRefs: [ref] }, { kind: "user" }))
    .rejects.toBeInstanceOf(BotConflictError);
  await registry.attachSessions(first.botId, { requestId: "shared", sessionRefs: [ref] }, { kind: "user" });
  await expect(registry.attachSessions(second.botId, { requestId: "shared", sessionRefs: [ref] }, { kind: "user" }))
    .rejects.toBeInstanceOf(BotConflictError);
});

test("permits only an attached session of a granted Bot to call add_bot", async () => {
  const { project, secondProject, ref, registry } = await fixture();
  const chief = await registry.add({
    requestId: "chief",
    name: "Chief of Staff",
    directoryPath: project,
    grants: ["add_bot"],
  }, { kind: "user" });
  await registry.attachSessions(chief.botId, { requestId: "attach-chief", sessionRefs: [ref] }, { kind: "user" });

  const created = await registry.add({ requestId: "tool-call", name: "Reviewer", directoryPath: secondProject }, {
    kind: "agent",
    session: ref,
  });
  expect(created.createdBy).toEqual({ kind: "bot", botId: chief.botId });
  expect(created.sessionRefs).toEqual([]);
  expect(created.grants).toEqual([]);

  await expect(registry.add({ requestId: "forbidden", name: "Third", directoryPath: secondProject }, {
    kind: "agent",
    session: { source: "pi", sessionId: "unattached" },
  })).rejects.toBeInstanceOf(BotForbiddenError);
  await expect(registry.add({
    requestId: "delegate",
    name: "Delegated",
    directoryPath: secondProject,
    grants: ["add_bot"],
  }, { kind: "agent", session: ref })).rejects.toBeInstanceOf(BotForbiddenError);
});

test("rejects directories and sessions outside the current catalog", async () => {
  const { project, registry } = await fixture();
  await expect(registry.add({ requestId: "missing", name: "Missing", directoryPath: join(project, "unknown") }, { kind: "user" }))
    .rejects.toBeInstanceOf(BotNotFoundError);

  const bot = await registry.add({ requestId: "known", name: "Known", directoryPath: project }, { kind: "user" });
  await expect(registry.attachSessions(bot.botId, {
    requestId: "missing-session",
    sessionRefs: [{ source: "claude", sessionId: "missing" }],
  }, { kind: "user" })).rejects.toBeInstanceOf(BotNotFoundError);
});

test("detaches a session and leaves the rest of the projection alone", async () => {
  const { project, ref, secondRef, registry } = await fixture();
  const bot = await registry.add({ requestId: "add", name: "Captain", directoryPath: project }, { kind: "user" });
  await registry.attachSessions(bot.botId, { requestId: "attach", sessionRefs: [ref, secondRef] }, { kind: "user" });

  const command = { requestId: "detach", sessionRefs: [ref] };
  const detached = await registry.detachSessions(bot.botId, command, { kind: "user" });

  expect(detached.sessionRefs).toEqual([secondRef]);
  expect(detached.sessions).toEqual([summary(secondRef, false)]);
  // Replayed rather than reapplied: a retried removal must not read as "already gone".
  expect((await registry.detachSessions(bot.botId, command, { kind: "user" })).sessionRefs).toEqual([secondRef]);
  expect((await registry.snapshot()).revision).toBe(3);
});

test("detaches a session the catalog has forgotten", async () => {
  const { project, ref, registry } = await fixture();
  const bot = await registry.add({ requestId: "add", name: "Captain", directoryPath: project }, { kind: "user" });
  await registry.attachSessions(bot.botId, { requestId: "attach", sessionRefs: [ref] }, { kind: "user" });

  // The transcript is gone from the catalog, so the Bot now carries it as a missing reference.
  // Attaching resolves against the catalog; detaching must not, or this row could never leave.
  sessions.delete(`${ref.source}:${ref.sessionId}`);
  expect((await registry.snapshot()).bots[0]!.missingSessionRefs).toEqual([ref]);

  const detached = await registry.detachSessions(
    bot.botId,
    { requestId: "detach-missing", sessionRefs: [ref] },
    { kind: "user" },
  );
  expect(detached.sessionRefs).toEqual([]);
  expect(detached.missingSessionRefs).toEqual([]);
});

test("refuses to detach what a Bot does not hold, and refuses agent actors entirely", async () => {
  const { project, ref, secondRef, registry } = await fixture();
  const bot = await registry.add({ requestId: "add", name: "Captain", directoryPath: project }, { kind: "user" });
  await registry.attachSessions(bot.botId, { requestId: "attach", sessionRefs: [ref] }, { kind: "user" });

  await expect(registry.detachSessions(bot.botId, { requestId: "absent", sessionRefs: [secondRef] }, { kind: "user" }))
    .rejects.toBeInstanceOf(BotNotFoundError);
  await expect(registry.detachSessions("missing-bot", { requestId: "no-bot", sessionRefs: [ref] }, { kind: "user" }))
    .rejects.toBeInstanceOf(BotNotFoundError);
  // Curating the roster is the user's, not a granted Bot's: `add_bot` widens what an agent may
  // create, never what it may take away.
  await expect(registry.detachSessions(bot.botId, { requestId: "agent", sessionRefs: [ref] }, {
    kind: "agent",
    session: ref,
  })).rejects.toBeInstanceOf(BotForbiddenError);
  expect((await registry.snapshot()).bots[0]!.sessionRefs).toEqual([ref]);
});

test("creating a Bot with launch starts a session in its directory and attaches it", async () => {
  const { launched, launcher } = recordingLauncher();
  const { project, registry } = await fixture(launcher);

  const bot = await registry.add({
    requestId: "request-1",
    name: "OSS agent",
    directoryPath: project,
    launch: { prompt: "Familiarize yourself with the repo." },
  }, { kind: "user" });

  // The title defaults to the Bot's name, which is what makes one call enough: `-n` sets the
  // session's address, and a Bot whose session answers to something else is a Bot nobody can
  // message.
  expect(launched).toEqual([{
    cwd: project,
    sessionId: "started-1",
    title: "OSS agent",
    prompt: "Familiarize yourself with the repo.",
  }]);
  expect(bot.sessionRefs).toEqual([{ source: "claude", sessionId: "started-1" }]);
  // Not in `sessions` yet: the catalog cannot resolve a session whose transcript does not exist,
  // and saying so is more honest than pretending it is live.
  expect(bot.sessions).toEqual([]);
  expect(bot.missingSessionRefs).toEqual([{ source: "claude", sessionId: "started-1" }]);
});

test("a launch title overrides the Bot's name, and a prompt is optional", async () => {
  const { launched, launcher } = recordingLauncher();
  const { project, registry } = await fixture(launcher);

  await registry.add({
    requestId: "request-1",
    name: "OSS agent",
    directoryPath: project,
    launch: { title: "OSS agent familiarization" },
  }, { kind: "user" });

  expect(launched).toEqual([{
    cwd: project,
    sessionId: "started-1",
    title: "OSS agent familiarization",
    prompt: undefined,
  }]);
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

  const first = await registry.add(command, { kind: "user" });
  const replay = await registry.add(command, { kind: "user" });

  expect(replay.botId).toBe(first.botId);
  expect(replay.sessionRefs).toEqual(first.sessionRefs);
  expect(launched).toHaveLength(1);
});

test("a launch failure leaves the Bot behind and says so", async () => {
  const { launched, launcher } = recordingLauncher(new Error("tmux is not installed"));
  const { project, registry } = await fixture(launcher);

  await expect(registry.add({
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
  await registry.add({
    requestId: "request-1",
    name: "Owner",
    directoryPath: project,
    grants: ["add_bot"],
  }, { kind: "user" });
  await registry.attachSessions("bot-1", { requestId: "attach-1", sessionRefs: [ref] }, { kind: "user" });

  await expect(registry.add({
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

  await expect(registry.add({
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
      launched.push({ ...options });
      if (broken) throw failure;
      return options;
    },
  };
  const { project, registry } = await fixture(launcher);
  const command = {
    requestId: "request-1",
    name: "OSS agent",
    directoryPath: project,
    launch: { prompt: "Read AGENTS.md." },
  } as const;

  await expect(registry.add(command, { kind: "user" })).rejects.toBeInstanceOf(BotLaunchError);
  broken = false;
  const recovered = await registry.add(command, { kind: "user" });

  expect(launched).toHaveLength(2);
  expect(recovered.sessionRefs).toEqual([{ source: "claude", sessionId: "started-2" }]);
  // Still one Bot: the replay finished the command rather than making a second.
  expect((await registry.snapshot()).bots).toHaveLength(1);
});
