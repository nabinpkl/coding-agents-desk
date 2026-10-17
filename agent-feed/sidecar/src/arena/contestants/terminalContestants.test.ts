// The two terminals-mode drivers against fake tmux steps: what is pinned here is the ORDER -- pane,
// ready, start line, then the prompt, and a turn closed by what the harness itself wrote -- and that
// the confinement is the headless one. Real tmux and real panes are the canvas's daily path.

import { describe, expect, test } from "bun:test";
import type { AgentSessionDescriptor, TimelineEnvelope } from "@agentdesk/agent-feed-wire";
import type { ContestantPlan } from "@/arena/contestants/contestantDriver";
import { ClaudeContestantError } from "@/arena/contestants/claudeContestant";
import type { OpencodeContestantBackend } from "@/arena/contestants/opencodeContestant";
import {
  claudeTurnClosed,
  runClaudeTerminalContestant,
  runOpencodeTerminalContestant,
  type TerminalContestantSteps,
} from "@/arena/contestants/terminalContestants";

const SESSION = "6a0f3e2c-1b44-4f8e-8c2d-5d9b0a7e3f21";

const userLine = JSON.stringify({
  type: "user",
  uuid: "u0",
  parentUuid: null,
  timestamp: "2026-10-12T10:00:00.000Z",
  sessionId: SESSION,
  cwd: "/arena/run/c1",
  message: { role: "user", content: "say one word" },
});

const endTurnLine = JSON.stringify({
  type: "assistant",
  uuid: "a1",
  parentUuid: "u0",
  timestamp: "2026-10-12T10:00:02.000Z",
  sessionId: SESSION,
  cwd: "/arena/run/c1",
  message: {
    id: "msg_a1",
    role: "assistant",
    model: "claude-haiku-4-5-20251001",
    type: "message",
    content: [{ type: "text", text: "alder" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 },
  },
});

describe("claudeTurnClosed", () => {
  test("closes only once a turn was opened and its last boundary says it ended", () => {
    expect(claudeTurnClosed("")).toBe(false);
    expect(claudeTurnClosed(userLine)).toBe(false);
    expect(claudeTurnClosed([userLine, endTurnLine].join("\n"))).toBe(true);
    expect(claudeTurnClosed([userLine, endTurnLine, userLine].join("\n"))).toBe(false);
  });
});

/** A plan whose terminal hooks write down what happened, in order. */
function planWith(log: string[], over: Partial<ContestantPlan> = {}): ContestantPlan {
  return {
    // Empty, as a run that opened its lanes before its prompt has it: the line carries the prompt.
    prompt: "",
    worktreePath: "/arena/run/c1",
    requestId: "run-1:c1",
    turnTimeoutMs: 1000,
    onSessionId: () => log.push("onSessionId"),
    terminal: {
      label: "arena c1 run-1",
      onPane: (pane, sessionId) => log.push(`pane:${pane}:${sessionId}`),
      ready: async () => {
        log.push("ready");
        // The start line hands over the prompt the reader typed, not the plan's own.
        return "say one word";
      },
    },
    ...over,
  };
}

/** Steps that log each act, and a transcript the test writes to when the prompt is typed. */
function fakeSteps(log: string[], options: { composer?: boolean; exited?: boolean; transcript?: string } = {}) {
  let transcript: string | null = options.transcript ?? null;
  const writers = new Set<() => void>();
  let command: string[] = [];
  const steps: TerminalContestantSteps = {
    async startClaude(o) {
      command = o.command;
      log.push(`startClaude:${o.cwd}:${o.title}`);
      return "arena-c1-pane";
    },
    async startOpencode(o) {
      log.push(`startOpencode:${o.cwd}:${o.sessionId}`);
      return "arena-c2-pane";
    },
    async awaitComposer() {
      log.push("awaitComposer");
      return options.composer ?? true;
    },
    async settlePane(pane) {
      log.push(`settle:${pane}`);
    },
    async harnessExited() {
      return options.exited ?? false;
    },
    async paneTail() {
      return "zsh:1: command not found: opencode";
    },
    async typePrompt(_sessionId, prompt) {
      log.push(`type:${prompt}`);
      // The CLI writes the prompt, then the reply, and the catalog's watch says so each time.
      transcript = userLine;
      for (const write of writers) write();
      transcript = [userLine, endTurnLine].join("\n");
      for (const write of writers) write();
    },
    watchTranscript(_sessionId, onWrite) {
      log.push("watch");
      writers.add(onWrite);
      return () => writers.delete(onWrite);
    },
    async readTranscript() {
      if (transcript === null) throw new Error("no transcript yet");
      return transcript;
    },
  };
  return { steps, command: () => command };
}

describe("runClaudeTerminalContestant", () => {
  test("starts the pane, waits for the composer and the start line, then types the prompt", async () => {
    const log: string[] = [];
    const { steps } = fakeSteps(log);
    const result = await runClaudeTerminalContestant(planWith(log), {
      binary: "/bin/claude",
      newSessionId: () => SESSION,
      steps,
    });
    expect(log).toEqual([
      "startClaude:/arena/run/c1:arena c1 run-1",
      `pane:arena-c1-pane:${SESSION}`,
      "awaitComposer",
      "ready",
      "watch",
      "type:say one word",
    ]);
    expect(result.sessionId).toBe(SESSION);
    expect(result.events.length).toBeGreaterThan(0);
    expect(result.usage).not.toBeNull();
  });

  test("runs the headless command, interactively and under the contestant's name", async () => {
    const log: string[] = [];
    const { steps, command } = fakeSteps(log);
    await runClaudeTerminalContestant(planWith(log), { binary: "/bin/claude", newSessionId: () => SESSION, steps });
    const argv = command();
    expect(argv).not.toContain("--print");
    expect(argv.slice(0, 5)).toEqual(["/bin/claude", "--session-id", SESSION, "-n", "arena c1 run-1"]);
    expect(argv).toEqual(["/bin/claude", "--session-id", SESSION, "-n", "arena c1 run-1"]);
  });

  test("a CLI that exits on its way up fails at once, saying what its pane said", async () => {
    const log: string[] = [];
    const { steps } = fakeSteps(log, { composer: false, exited: true });
    await expect(
      runClaudeTerminalContestant(planWith(log), { binary: "/bin/claude", newSessionId: () => SESSION, steps }),
    ).rejects.toThrow(/exited before taking the prompt: zsh:1/);
    expect(log).not.toContain("ready");
  });

  test("a composer that never appears fails the contestant before the start line, pane left open", async () => {
    const log: string[] = [];
    const { steps } = fakeSteps(log, { composer: false });
    await expect(
      runClaudeTerminalContestant(
        planWith(log, { turnTimeoutMs: 0 }),
        { binary: "/bin/claude", newSessionId: () => SESSION, steps },
      ),
    ).rejects.toThrow(ClaudeContestantError);
    expect(log).not.toContain("ready");
    expect(log.some((line) => line.startsWith("type:"))).toBe(false);
  });

  test("a plan without terminal hooks is a run's bug, refused before any pane", async () => {
    const log: string[] = [];
    const { steps } = fakeSteps(log);
    await expect(
      runClaudeTerminalContestant(planWith(log, { terminal: undefined }), { binary: "/bin/claude", steps }),
    ).rejects.toThrow(/no terminal/);
    expect(log).toEqual([]);
  });
});

describe("runOpencodeTerminalContestant", () => {
  test("makes the session first, then the pane, the start line, and the prompt through the serve", async () => {
    const log: string[] = [];
    const { steps } = fakeSteps(log);
    const backend: OpencodeContestantBackend = {
      async createSession(_requestId, projectPath) {
        log.push(`create:${projectPath}`);
        return { sessionId: "ses_1", projectPath } as AgentSessionDescriptor;
      },
      async subscribe(_sessionId, _after, listener) {
        log.push("subscribe");
        const idle: TimelineEnvelope = {
          kind: "state", sequence: 1, mode: "nice", events: [], windowStart: 0, runState: "idle",
          queue: { steer: 0, followUp: 0 },
        };
        queueMicrotask(() => listener(idle));
        return () => {};
      },
      async send(_sessionId, _requestId, text) {
        log.push(`send:${text}`);
        return { requestId: "r", delivery: "immediate" };
      },
    };
    const result = await runOpencodeTerminalContestant(backend, planWith(log), {
      steps,
      turnOutcome: async () => ({ closed: true, failure: null }),
    });
    expect(log).toEqual([
      "create:/arena/run/c1",
      "startOpencode:/arena/run/c1:ses_1",
      "pane:arena-c2-pane:ses_1",
      "settle:arena-c2-pane",
      "ready",
      "subscribe",
      "send:say one word",
    ]);
    expect(result.sessionId).toBe("ses_1");
  });

  test("a TUI that exited before the prompt fails the contestant rather than running it unseen", async () => {
    const log: string[] = [];
    const { steps } = fakeSteps(log, { exited: true });
    const backend = {
      async createSession(_requestId: string, projectPath: string) {
        return { sessionId: "ses_2", projectPath } as AgentSessionDescriptor;
      },
      async subscribe() {
        log.push("subscribe");
        return () => {};
      },
      async send() {
        log.push("send");
        return { requestId: "r", delivery: "immediate" as const };
      },
    };
    await expect(
      runOpencodeTerminalContestant(backend, planWith(log), { steps }),
    ).rejects.toThrow(/TUI exited before the prompt: zsh:1: command not found/);
    expect(log).not.toContain("ready");
    expect(log).not.toContain("send");
  });
});

/** The plan of a contestant a restarted sidecar is picking back up, its prompt the run's own. */
function resumedPlan(log: string[], pane: string, sessionId: string, prompted: boolean): ContestantPlan {
  const plan = planWith(log, { prompt: "say one word" });
  return { ...plan, terminal: { ...plan.terminal!, resume: { pane, sessionId, prompted } } };
}

/** A serve whose turn closes at once, logging what it was asked to do. */
function idleBackend(log: string[]): OpencodeContestantBackend {
  return {
    async createSession(_requestId, projectPath) {
      log.push("create");
      return { sessionId: "ses_new", projectPath } as AgentSessionDescriptor;
    },
    async subscribe(_sessionId, _after, listener) {
      log.push("subscribe");
      const idle: TimelineEnvelope = {
        kind: "state", sequence: 1, mode: "nice", events: [], windowStart: 0, runState: "idle",
        queue: { steer: 0, followUp: 0 },
      };
      queueMicrotask(() => listener(idle));
      return () => {};
    },
    async send(_sessionId, _requestId, text) {
      log.push(`send:${text}`);
      return { requestId: "r", delivery: "immediate" };
    },
  };
}

describe("a contestant picked back up after a restart", () => {
  test("Claude, not yet let go: no new pane, back to its composer and the start line", async () => {
    const log: string[] = [];
    const { steps } = fakeSteps(log);
    await runClaudeTerminalContestant(resumedPlan(log, "arena-c1-old", SESSION, false), { binary: "/bin/claude", steps });
    expect(log).toEqual(["awaitComposer", "ready", "watch", "type:say one word"]);
  });

  test("Claude, let go and its turn already closed: watched to the close, never typed again", async () => {
    const log: string[] = [];
    const { steps } = fakeSteps(log, { transcript: [userLine, endTurnLine].join("\n") });
    const result = await runClaudeTerminalContestant(resumedPlan(log, "arena-c1-old", SESSION, true), { steps });
    expect(log).toEqual(["watch"]);
    expect(result.sessionId).toBe(SESSION);
    expect(result.events.length).toBeGreaterThan(0);
  });

  test("Claude, let go but its transcript shows no turn opened: typed the run's prompt once", async () => {
    const log: string[] = [];
    const { steps } = fakeSteps(log);
    await runClaudeTerminalContestant(resumedPlan(log, "arena-c1-old", SESSION, true), { steps });
    expect(log).toEqual(["watch", "type:say one word"]);
  });

  test("Claude, not yet let go, whose CLI went with the old sidecar: fails saying what the pane shows", async () => {
    const log: string[] = [];
    const { steps } = fakeSteps(log, { composer: false, exited: true });
    await expect(
      runClaudeTerminalContestant(resumedPlan(log, "arena-c1-old", SESSION, false), { steps }),
    ).rejects.toThrow(/exited before taking the prompt/);
    expect(log).not.toContain("ready");
  });

  test("opencode, not yet let go: no new session or pane, back to the start line, then sent", async () => {
    const log: string[] = [];
    const { steps } = fakeSteps(log);
    await runOpencodeTerminalContestant(idleBackend(log), resumedPlan(log, "arena-c2-old", "ses_old", false), {
      steps,
      turnOutcome: async () => ({ closed: true, failure: null }),
    });
    expect(log).toEqual(["ready", "subscribe", "send:say one word"]);
  });

  test("opencode, let go: watched without a send when the serve holds the prompt, sent when not", async () => {
    for (const [held, expected] of [[true, ["subscribe"]], [false, ["subscribe", "send:say one word"]]] as const) {
      const log: string[] = [];
      const { steps } = fakeSteps(log);
      await runOpencodeTerminalContestant(idleBackend(log), resumedPlan(log, "arena-c2-old", "ses_old", true), {
        steps,
        promptSent: async () => held,
        turnOutcome: async () => ({ closed: true, failure: null }),
      });
      expect(log).toEqual([...expected]);
    }
  });
});
