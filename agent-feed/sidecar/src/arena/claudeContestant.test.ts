// A fake child rather than a real `claude`: what is pinned here is the driver's contract --
// the session id is announced before the harness runs, a non-zero exit or a timeout fails the
// contestant, and the facts come back through the real Claude adapter. The real CLI is
// exercised by the arena's end-to-end run, not by the unit suite.

import { describe, expect, test } from "bun:test";
import {
  ClaudeContestantError,
  claudeContestantArgv,
  factsFromClaudeTranscript,
  runClaudeContestant,
  type SpawnedClaude,
} from "@/arena/claudeContestant";
import { filesFromEvents } from "@/arena/arenaFacts";

const SESSION = "4f1c9a2e-0d55-4c8b-9b3a-7e2a1c0f9d11";

/** One assistant line in the shape the CLI writes, carrying one tool call. */
function toolLine(name: string, input: Record<string, unknown>, uuid: string): string {
  return JSON.stringify({
    type: "assistant",
    uuid,
    parentUuid: null,
    timestamp: "2026-10-11T09:52:35.291Z",
    sessionId: SESSION,
    cwd: "/arena/run/c1",
    isSidechain: false,
    message: {
      id: `msg_${uuid}`,
      role: "assistant",
      model: "claude-haiku-4-5-20251001",
      type: "message",
      content: [{ type: "tool_use", id: `toolu_${uuid}`, name, input }],
      stop_reason: "tool_use",
      usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 5 },
    },
  });
}

const TRANSCRIPT = [
  JSON.stringify({ type: "queue-operation", operation: "enqueue", sessionId: SESSION }),
  toolLine("Read", { file_path: "/arena/run/c1/README.md" }, "u1"),
  toolLine("Edit", { file_path: "/arena/run/c1/src/widget.ts", old_string: "a", new_string: "b" }, "u2"),
  "",
].join("\n");

function fakeChild(options: { code?: number; stderr?: string; hang?: boolean } = {}) {
  let killed = false;
  let release: (code: number) => void = () => {};
  const exited = options.hang
    ? new Promise<number>((resolve) => { release = resolve; })
    : Promise.resolve(options.code ?? 0);
  const child: SpawnedClaude = {
    exited,
    stderrText: async () => options.stderr ?? "",
    kill: () => {
      killed = true;
      release(143);
    },
  };
  return { child, wasKilled: () => killed };
}

const basePlan = {
  prompt: "say one word",
  worktreePath: "/arena/run/c1",
  requestId: "run-1:c1",
  turnTimeoutMs: 1000,
};

describe("claudeContestantArgv", () => {
  test("print mode and the chosen session, with no prompt in argv and nothing confining it", () => {
    expect(claudeContestantArgv({ binary: "/bin/claude", sessionId: SESSION, model: "haiku", effort: "low" })).toEqual([
      "/bin/claude", "--print", "--session-id", SESSION, "--model", "haiku", "--effort", "low",
    ]);
  });

  test("leaves model and effort to the CLI when none is configured", () => {
    const argv = claudeContestantArgv({ binary: "/bin/claude", sessionId: SESSION });
    expect(argv).not.toContain("--model");
    expect(argv).not.toContain("--effort");
  });
});

describe("factsFromClaudeTranscript", () => {
  test("reads the turn through the Claude adapter, skipping the machinery lines", () => {
    const { events, usage } = factsFromClaudeTranscript(TRANSCRIPT);
    expect(events.length).toBe(2);
    expect(new Set(events.map((one) => one.id)).size).toBe(2);
    expect(usage).not.toBeNull();
    const { filesRead, filesWritten } = filesFromEvents(events);
    expect(filesRead).toEqual(["/arena/run/c1/README.md"]);
    expect(filesWritten).toEqual(["/arena/run/c1/src/widget.ts"]);
  });
});

describe("runClaudeContestant", () => {
  test("announces the chosen session before spawning, prompt on stdin, cwd the worktree", async () => {
    const order: string[] = [];
    let spawned: { argv: string[]; cwd: string; prompt: string } | null = null;
    const result = await runClaudeContestant(
      { ...basePlan, onSessionId: (id) => order.push(`session:${id}`) },
      {
        binary: "/bin/claude",
        newSessionId: () => SESSION,
        spawn: async (argv, cwd, prompt) => {
          order.push("spawn");
          spawned = { argv, cwd, prompt };
          return fakeChild().child;
        },
        readTranscript: async (id) => {
          expect(id).toBe(SESSION);
          return TRANSCRIPT;
        },
      },
    );
    expect(order).toEqual([`session:${SESSION}`, "spawn"]);
    expect(spawned!.cwd).toBe("/arena/run/c1");
    expect(spawned!.prompt).toBe("say one word");
    expect(spawned!.argv).not.toContain("say one word");
    expect(result.sessionId).toBe(SESSION);
    expect(result.events.length).toBe(2);
  });

  test("a non-zero exit fails the contestant with the tail of stderr", async () => {
    await expect(
      runClaudeContestant(
        { ...basePlan, onSessionId: () => {} },
        {
          binary: "/bin/claude",
        newSessionId: () => SESSION,
          spawn: async () => fakeChild({ code: 1, stderr: "Not logged in" }).child,
          readTranscript: async () => TRANSCRIPT,
        },
      ),
    ).rejects.toThrow("claude exited 1: Not logged in");
  });

  test("no claude on this machine fails the contestant before anything spawns", async () => {
    let spawned = false;
    await expect(
      runClaudeContestant(
        { ...basePlan, onSessionId: () => {} },
        {
          binary: null,
          spawn: async () => {
            spawned = true;
            return fakeChild().child;
          },
        },
      ),
    ).rejects.toThrow("AGENT_FEED_CLAUDE_PATH");
    expect(spawned).toBe(false);
  });

  test("a turn past its timeout is killed and fails as a timeout, not an exit code", async () => {
    const fake = fakeChild({ hang: true });
    await expect(
      runClaudeContestant(
        { ...basePlan, turnTimeoutMs: 20, onSessionId: () => {} },
        {
          binary: "/bin/claude",
        newSessionId: () => SESSION,
          spawn: async () => fake.child,
          readTranscript: async () => TRANSCRIPT,
        },
      ),
    ).rejects.toThrow(ClaudeContestantError);
    expect(fake.wasKilled()).toBe(true);
  });
});
