// The world one BotRegistry test runs in: a catalog of known projects and sessions, a
// temporary Bot directory, and a launcher that records what it was asked to start
// rather than reaching for tmux.
//
// A function rather than module state, so each test file gets its own catalog and its
// own cleanup. Call it once at the top of a file; the `afterEach` it registers belongs
// to that file.

import { afterEach } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BotSessionRef, SessionSummary } from "@agentdesk/agent-feed-wire";
import { BotStore } from "@/bots/botStore";
import {
  BotRegistry,
  type BotRegistryCatalog,
  type BotSessionLauncher,
  type ResolvedBotSession,
} from "@/bots/botRegistry";
import type { ForkRewinder } from "@/transcripts/session-ops/forkSession";
import { forgetWorktrees } from "@/git/worktree";

export interface LaunchRecord {
  kind: "start" | "fork";
  cwd: string;
  sessionId: string;
  forkId?: string;
  title: string;
  prompt?: string;
  brief?: string;
}

export function botRegistryHarness() {
  const temporaryDirectories: string[] = [];
  const projects = new Set<string>();
  const sessions = new Map<string, ResolvedBotSession>();
  const listeners = new Set<() => void>();
  /**
   * Which sessions have a pane, and what it is called.
   *
   * A test opts a session into being "running" by putting it here; anything absent answers null
   * from `end`, which is the ordinary case rather than a failure. `endedPanes` is what a test
   * asserts against, because the whole point of the seam is that no real pane was touched.
   */
  const runningPanes = new Map<string, string>();
  const endedPanes: string[] = [];
  /**
   * What a fork from a message asked to be moved back to. Always a stand-in: the live rewinder
   * drives a real pane, which no test here may reach.
   */
  const rewound: Parameters<ForkRewinder>[0][] = [];
  const rewinder: ForkRewinder = async (options) => {
    rewound.push(options);
    return { done: true };
  };

  async function endPane(options: { sessionId: string }): Promise<string | null> {
    const pane = runningPanes.get(options.sessionId);
    if (!pane) return null;
    runningPanes.delete(options.sessionId);
    endedPanes.push(pane);
    return pane;
  }

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
    runningPanes.clear();
    endedPanes.length = 0;
    rewound.length = 0;
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
        end: endPane,
      },
    };
  }

  async function git(command: string[], cwd: string): Promise<void> {
    const process = Bun.spawn(["git", ...command], { cwd, stdout: "ignore", stderr: "ignore" });
    const code = await process.exited;
    if (code !== 0) throw new Error(`git ${command.join(" ")} exited ${code}`);
  }

  /**
   * A Bot's directory as a real repository, with one linked worktree beside it.
   *
   * A real one rather than a fake, because everything worth testing about worktrees here is
   * something git decides: whether a directory is a worktree of THIS checkout, whether it is
   * clean, and whether a branch is merged enough to delete.
   */
  async function checkoutWithWorktree(
    { remote = false }: { remote?: boolean } = {},
  ): Promise<{ checkout: string; worktree: string; remote?: string }> {
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
    if (!remote) return { checkout, worktree };
    // A real bare repository, pushed to with `-u`. The tracking config is the whole subject of the
    // remote checks, so a stand-in that did not set it would test the opposite of what is meant.
    const bare = join(root, "remote.git");
    await git(["init", "-q", "--bare", bare], root);
    await git(["remote", "add", "origin", bare], checkout);
    await git(["push", "-q", "-u", "origin", "main"], checkout);
    await git(["push", "-q", "-u", "origin", "side"], checkout);
    return { checkout, worktree, remote: bare };
  }

  /** The branches a bare repository holds, for asserting what a remote delete did or did not do. */
  async function remoteBranches(bare: string): Promise<string[]> {
    const listed = Bun.spawnSync(["git", "branch", "--format=%(refname:short)"], { cwd: bare });
    return listed.stdout.toString().split("\n").filter(Boolean).sort();
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
          end: endPane,
        },
        () => `started-${++nextSessionId}`,
        rewinder,
      ),
    };
  }


  /**
   * Fires a catalog event, the way ordinary session churn does: a session's state or token count
   * changing, with no Bot touched. Exposed because a subscriber that cannot tell this apart from a
   * real change republishes on every one of them, and nothing else in the suite can produce one.
   */
  function notifyCatalog(): void {
    for (const listener of [...listeners]) listener();
  }

  return {
    addBot,
    addSessions,
    checkoutWithWorktree,
    endedPanes,
    fixture,
    git,
    notifyCatalog,
    projects,
    recordingLauncher,
    remoteBranches,
    rewound,
    runningPanes,
    sessions,
    summary,
    temporaryDirectories,
  };
}
