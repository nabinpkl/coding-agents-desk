import { describe, expect, test } from "bun:test";
import type { ClaudeSdkSessionState } from "@agentdesk/agent-feed-wire";
import type { ClaudeSessionProcess } from "@/tasks/sessionRegistry";
import { switchRunMode, type SwitchSteps } from "@/claude-sdk/claudeSdkSwitch";

const ID = "11111111-2222-4333-8444-555555555555";
const SESSION = { sessionId: ID, cwd: "/repo", title: "Garden" };
const TERMINAL_PANE = { pane: "%7", command: `zsh -l -c 'claude --resume ${ID}; exec zsh -l'` };
const RUNNER_PANE = { pane: "%7", command: `zsh -l -c 'bun /x/claude-sdk/claudeSdkRunnerMain.ts --session ${ID}; exec zsh -l'` };

const IDLE_RUNNER: ClaudeSdkSessionState = {
  connected: true,
  status: "idle",
  permissionMode: "auto",
  allowBypass: true,
  pending: [],
  backgroundTasks: 0,
  claudeCodeVersion: "2.1.302",
  model: null,
  models: [],
};

function row(overrides: Partial<ClaudeSessionProcess> = {}): ClaudeSessionProcess {
  return {
    pid: 4242,
    sessionId: ID,
    cwd: "/repo",
    startedAt: 1,
    messagingSocketPath: null,
    entrypoint: "cli",
    tmuxSession: "garden",
    waiting: false,
    activity: "idle",
    version: "2.1.302",
    name: "Garden",
    ...overrides,
  };
}

/** Steps that record what they were asked, with a process that leaves after `leavesAfter` looks. */
function steps(options: {
  rows: ClaudeSessionProcess[];
  pane?: { pane: string; command: string } | null;
  runner?: Partial<ClaudeSdkSessionState>;
  leavesAfter?: number;
  respawnFails?: boolean;
}) {
  const done: string[] = [];
  let looks = 0;
  let stopped = false;
  const fake: SwitchSteps = {
    processes: async () => {
      if (!stopped) return options.rows;
      looks += 1;
      return looks > (options.leavesAfter ?? 1) ? [] : options.rows;
    },
    runnerState: async () => ({ ...IDLE_RUNNER, ...options.runner }),
    stopRunner: async () => {
      stopped = true;
      done.push("stop runner");
      return { ok: true };
    },
    hangUp: (pid) => {
      stopped = true;
      done.push(`hang up ${pid}`);
    },
    stamped: async () => (options.pane === null ? null : "garden"),
    paneStarts: async () => (options.pane ? [options.pane] : []),
    exited: async () => true,
    respawn: async (pane, cwd, command) => {
      if (options.respawnFails) throw new Error("tmux said no");
      done.push(`respawn ${pane} ${cwd} ${command.join(" ")}`);
    },
    resumeCommand: (mode, { sessionId }) => [mode === "sdk" ? "runner" : "claude", sessionId],
    sleep: async () => {},
  };
  return { done, steps: fake };
}

describe("moving a session between the terminal and the SDK", () => {
  test("hangs up the terminal, waits for it to leave, then starts the runner in the same pane", async () => {
    const { done, steps: s } = steps({ rows: [row()], pane: TERMINAL_PANE, leavesAfter: 3 });
    expect(await switchRunMode(SESSION, "sdk", s)).toEqual({ ok: true });
    expect(done).toEqual(["hang up 4242", `respawn %7 /repo runner ${ID}`]);
  });

  test("stops the runner, then resumes the terminal in its pane", async () => {
    const { done, steps: s } = steps({ rows: [row({ entrypoint: "sdk-cli" })], pane: RUNNER_PANE });
    expect(await switchRunMode(SESSION, "terminal", s)).toEqual({ ok: true });
    expect(done).toEqual(["stop runner", `respawn %7 /repo claude ${ID}`]);
  });

  test("starts nothing new when the old process does not leave", async () => {
    const { done, steps: s } = steps({ rows: [row()], pane: TERMINAL_PANE, leavesAfter: Number.POSITIVE_INFINITY });
    expect(await switchRunMode(SESSION, "sdk", s)).toMatchObject({ ok: false, reason: "failed" });
    expect(done).toEqual(["hang up 4242"]);
  });

  test("says where it was left when the new start fails", async () => {
    const { steps: s } = steps({ rows: [row()], pane: TERMINAL_PANE, respawnFails: true });
    const outcome = await switchRunMode(SESSION, "sdk", s);
    expect(outcome).toMatchObject({ ok: false, reason: "failed" });
    expect(outcome.ok ? "" : outcome.message).toContain("open it to resume it");
  });
});

describe("what it refuses, touching nothing", () => {
  const refused = async (options: Parameters<typeof steps>[0], mode: "sdk" | "terminal" = "sdk") => {
    const { done, steps: s } = steps(options);
    const outcome = await switchRunMode(SESSION, mode, s);
    expect(done).toEqual([]);
    return outcome.ok ? null : outcome.reason;
  };

  test("a session nothing is running, or two processes are", async () => {
    expect(await refused({ rows: [] })).toBe("not-running");
    expect(await refused({ rows: [row(), row({ pid: 5 })] })).toBe("several-processes");
  });

  test("a session in a Desktop window, or already in the mode asked for", async () => {
    expect(await refused({ rows: [row({ entrypoint: "claude-desktop" })] })).toBe("not-ours");
    expect(await refused({ rows: [row()] }, "terminal")).toBe("already");
  });

  test("a terminal session that is not idle", async () => {
    for (const activity of ["busy", "waiting", "shell", null] as const) {
      expect(await refused({ rows: [row({ activity })], pane: TERMINAL_PANE })).toBe("busy");
    }
  });

  test("an SDK session with a turn running, a request waiting, a background task, or no runner", async () => {
    const sdk = [row({ entrypoint: "sdk-cli" })];
    for (const runner of [
      { status: "running" as const },
      { pending: [{ kind: "approval" as const, toolUseId: "t", toolName: "Bash", input: {}, openedAt: 1 }] },
      { backgroundTasks: 1 },
      { connected: false },
    ]) {
      expect(await refused({ rows: sdk, pane: RUNNER_PANE, runner }, "terminal")).toBe("busy");
    }
  });

  test("a pane this sidecar did not start, or one running the other mode", async () => {
    expect(await refused({ rows: [row()], pane: null })).toBe("not-ours");
    expect(await refused({ rows: [row()], pane: { pane: "%1", command: "zsh" } })).toBe("not-ours");
    expect(await refused({ rows: [row()], pane: RUNNER_PANE })).toBe("not-ours");
  });
});
