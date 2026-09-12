// The world one BotRegistry test runs in: a catalog of known projects and sessions, a
// temporary Bot directory, and a launcher that records what it was asked to start
// rather than reaching for tmux.
//
// A function rather than module state, so each test file gets its own catalog and its
// own cleanup. Call it once at the top of a file; the `afterEach` it registers belongs
// to that file.

import { afterEach } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BotSessionRef, SessionSummary } from "@agentdesk/agent-feed-wire";
import { BotStore } from "@/bots/botStore";
import {
  BotRegistry,
  type BotRegistryCatalog,
  type BotSessionLauncher,
} from "@/bots/botRegistry";
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


  return {
    addBot,
    addSessions,
    fixture,
    projects,
    recordingLauncher,
    sessions,
    summary,
    temporaryDirectories,
  };
}
