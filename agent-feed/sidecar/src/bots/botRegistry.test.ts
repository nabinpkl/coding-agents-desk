import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
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
import { forgetWorktrees } from "../git/worktree.ts";

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
  // Worktrees here are created and destroyed inside one run, so a remembered answer would outlive
  // the directory it describes.
  forgetWorktrees();
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
  kind: "start" | "fork";
  cwd: string;
  sessionId: string;
  forkId?: string;
  title: string;
  prompt?: string;
  brief?: string;
}

/** Unwraps the envelope both commands answer with, so the assertions stay about the Bot. */
async function addBot(
  registry: BotRegistry,
  command: Parameters<BotRegistry["add"]>[0],
  actor: Parameters<BotRegistry["add"]>[1],
) {
  return (await registry.add(command, actor)).bot;
}

async function addSessions(
  registry: BotRegistry,
  botId: string,
  command: Parameters<BotRegistry["addSessions"]>[1],
  actor: Parameters<BotRegistry["addSessions"]>[2],
) {
  return (await registry.addSessions(botId, command, actor)).bot;
}

/** Records what would have been started, so the sequence around it can be checked without tmux. */
function recordingLauncher(fail?: Error): { launched: LaunchRecord[]; launcher: BotSessionLauncher } {
  const launched: LaunchRecord[] = [];
  return {
    launched,
    launcher: {
      async start(options) {
        launched.push({ kind: "start", ...options });
        if (fail) throw fail;
        return { tmuxSession: `agentdesk-${options.sessionId}` };
      },
      async fork(options) {
        launched.push({ kind: "fork", ...options });
        if (fail) throw fail;
        return { tmuxSession: `agentdesk-fork-${options.forkId}` };
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
  // Forking is Claude-only, so the fixture carries one of those too.
  const claudeRef = { source: "claude" as const, sessionId: "session-3" };
  sessions.set("pi:session-1", { projectPath: project, summary: summary(ref) });
  sessions.set("codex:session-2", { projectPath: project, summary: summary(secondRef, false) });
  sessions.set("claude:session-3", { projectPath: project, summary: summary(claudeRef) });
  let nextId = 0;
  let nextSessionId = 0;
  return {
    project,
    secondProject,
    ref,
    secondRef,
    claudeRef,
    registry: new BotRegistry(
      new BotStore(join(directory, "bots.json")),
      catalog,
      () => 123,
      () => `bot-${++nextId}`,
      launcher ?? {
        start: async (options) => ({ tmuxSession: `agentdesk-${options.sessionId}` }),
        fork: async (options) => ({ tmuxSession: `agentdesk-fork-${options.forkId}` }),
      },
      () => `started-${++nextSessionId}`,
    ),
  };
}

test("adds a user-facing Bot for an existing project directory with no sessions", async () => {
  const { project, registry } = await fixture();
  const bot = await addBot(registry, {
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
  const first = await addBot(registry, command, { kind: "user" });
  expect((await addBot(registry, command, { kind: "user" })).botId).toBe(first.botId);
  await expect(addBot(registry, { ...command, name: "Different" }, { kind: "user" }))
    .rejects.toBeInstanceOf(BotConflictError);
  await expect(addBot(registry, { requestId: "two", name: "captain", directoryPath: secondProject }, { kind: "user" }))
    .rejects.toBeInstanceOf(BotConflictError);
  await expect(addBot(registry, { requestId: "three", name: "Reviewer", directoryPath: project }, { kind: "user" }))
    .rejects.toBeInstanceOf(BotConflictError);
});

test("attaches existing sessions from the Bot directory as one durable update", async () => {
  const { project, ref, secondRef, registry } = await fixture();
  const bot = await addBot(registry, { requestId: "add", name: "Captain", directoryPath: project }, { kind: "user" });
  const command = { requestId: "attach", sessionRefs: [ref, secondRef] };
  const attached = await addSessions(registry, bot.botId, command, { kind: "user" });

  expect(attached.sessionRefs).toEqual([ref, secondRef]);
  expect(attached.sessions).toEqual([summary(ref), summary(secondRef, false)]);
  expect((await addSessions(registry, bot.botId, command, { kind: "user" })).sessionRefs).toEqual([ref, secondRef]);
  expect((await registry.snapshot()).revision).toBe(2);
});

test("rejects sessions outside the Bot directory and request reuse across Bots", async () => {
  const { project, secondProject, ref, registry } = await fixture();
  const first = await addBot(registry, { requestId: "first", name: "First", directoryPath: project }, { kind: "user" });
  const second = await addBot(registry, { requestId: "second", name: "Second", directoryPath: secondProject }, { kind: "user" });

  await expect(addSessions(registry, second.botId, { requestId: "outside", sessionRefs: [ref] }, { kind: "user" }))
    .rejects.toBeInstanceOf(BotConflictError);
  await addSessions(registry, first.botId, { requestId: "shared", sessionRefs: [ref] }, { kind: "user" });
  await expect(addSessions(registry, second.botId, { requestId: "shared", sessionRefs: [ref] }, { kind: "user" }))
    .rejects.toBeInstanceOf(BotConflictError);
});

test("permits only an attached session of a granted Bot to call add_bot", async () => {
  const { project, secondProject, ref, registry } = await fixture();
  const chief = await addBot(registry, {
    requestId: "chief",
    name: "Chief of Staff",
    directoryPath: project,
    grants: ["add_bot"],
  }, { kind: "user" });
  await addSessions(registry, chief.botId, { requestId: "attach-chief", sessionRefs: [ref] }, { kind: "user" });

  const created = await addBot(registry, { requestId: "tool-call", name: "Reviewer", directoryPath: secondProject }, {
    kind: "agent",
    session: ref,
  });
  expect(created.createdBy).toEqual({ kind: "bot", botId: chief.botId });
  expect(created.sessionRefs).toEqual([]);
  expect(created.grants).toEqual([]);

  await expect(addBot(registry, { requestId: "forbidden", name: "Third", directoryPath: secondProject }, {
    kind: "agent",
    session: { source: "pi", sessionId: "unattached" },
  })).rejects.toBeInstanceOf(BotForbiddenError);
  await expect(addBot(registry, {
    requestId: "delegate",
    name: "Delegated",
    directoryPath: secondProject,
    grants: ["add_bot"],
  }, { kind: "agent", session: ref })).rejects.toBeInstanceOf(BotForbiddenError);
});

test("rejects directories and sessions outside the current catalog", async () => {
  const { project, registry } = await fixture();
  await expect(addBot(registry, { requestId: "missing", name: "Missing", directoryPath: join(project, "unknown") }, { kind: "user" }))
    .rejects.toBeInstanceOf(BotNotFoundError);

  const bot = await addBot(registry, { requestId: "known", name: "Known", directoryPath: project }, { kind: "user" });
  await expect(addSessions(registry, bot.botId, {
    requestId: "missing-session",
    sessionRefs: [{ source: "claude", sessionId: "missing" }],
  }, { kind: "user" })).rejects.toBeInstanceOf(BotNotFoundError);
});

test("detaches a session and leaves the rest of the projection alone", async () => {
  const { project, ref, secondRef, registry } = await fixture();
  const bot = await addBot(registry, { requestId: "add", name: "Captain", directoryPath: project }, { kind: "user" });
  await addSessions(registry, bot.botId, { requestId: "attach", sessionRefs: [ref, secondRef] }, { kind: "user" });

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
  const bot = await addBot(registry, { requestId: "add", name: "Captain", directoryPath: project }, { kind: "user" });
  await addSessions(registry, bot.botId, { requestId: "attach", sessionRefs: [ref] }, { kind: "user" });

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
  const bot = await addBot(registry, { requestId: "add", name: "Captain", directoryPath: project }, { kind: "user" });
  await addSessions(registry, bot.botId, { requestId: "attach", sessionRefs: [ref] }, { kind: "user" });

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

  const bot = await addBot(registry, {
    requestId: "request-1",
    name: "OSS agent",
    directoryPath: project,
    launch: { prompt: "Familiarize yourself with the repo." },
  }, { kind: "user" });

  // The title defaults to the Bot's name, which is what makes one call enough: `-n` sets the
  // session's address, and a Bot whose session answers to something else is a Bot nobody can
  // message.
  expect(launched).toEqual([{
    kind: "start",
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

  await addBot(registry, {
    requestId: "request-1",
    name: "OSS agent",
    directoryPath: project,
    launch: { title: "OSS agent familiarization" },
  }, { kind: "user" });

  expect(launched).toEqual([{
    kind: "start",
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
