// Who takes a run's next prompt, and how a closed turn's facts add to the ones before it.

import { describe, expect, test } from "bun:test";
import type { ArenaContestantRecord, ArenaRunRecord } from "@/arena/arenaRun";
import { ArenaNextPromptError, factsAfterTurn, nextPromptContestants } from "@/arena/arenaTurns";
import type { ActivityEvent } from "@/transcripts/transcriptTypes";

const contestant = (over: Partial<ArenaContestantRecord> = {}): ArenaContestantRecord => ({
  contestantId: "c1",
  source: "claude",
  model: null,
  sessionId: "s1",
  worktreePath: "/arena/run/c1",
  tmuxSession: "pane-c1",
  status: "closed",
  startedAt: 1,
  closedAt: 2,
  error: null,
  contextTokens: null,
  costUsd: null,
  filesRead: [],
  filesWritten: [],
  outsideReached: [],
  gitDiff: null,
  ...over,
});

const run = (contestants: ArenaContestantRecord[], mode: ArenaRunRecord["mode"] = "terminals"): ArenaRunRecord => ({
  runId: "11111111-1111-4111-8111-111111111111",
  manager: null,
  name: "arena run 1",
  folder: "/arena/run",
  prompt: "first",
  round: 1,
  repoPath: "/arena/run",
  repoCreated: true,
  baseRef: "HEAD",
  mode,
  createdAt: 1,
  contestants,
});

const call = (id: string, tool: string, input: Record<string, unknown>): ActivityEvent => ({
  id,
  index: 0,
  revision: 1,
  phase: "complete",
  ts: 1,
  type: "assistant",
  blocks: [{ kind: "tool_use", tool, input }],
});

describe("nextPromptContestants", () => {
  test("every contestant with a session and a pane takes it, a failed one included", () => {
    const failed = contestant({ contestantId: "c2", status: "failed", sessionId: "s2", tmuxSession: "pane-c2" });
    const never = contestant({ contestantId: "c3", status: "failed", sessionId: null, tmuxSession: null });
    expect(nextPromptContestants(run([contestant(), failed, never])).map((one) => one.contestantId)).toEqual(["c1", "c2"]);
  });

  test("a headless contestant needs only its session", () => {
    expect(nextPromptContestants(run([contestant({ tmuxSession: null })], "headless")).length).toBe(1);
  });

  test("is refused, as busy, while a lane is still on the last prompt", () => {
    const error = (() => {
      try {
        nextPromptContestants(run([contestant(), contestant({ contestantId: "c2", status: "running" })]));
      } catch (caught) {
        return caught;
      }
    })();
    expect(error).toBeInstanceOf(ArenaNextPromptError);
    expect((error as ArenaNextPromptError).busy).toBe(true);
  });

  test("is refused, not as busy, when nobody has a session to continue", () => {
    expect(() => nextPromptContestants(run([contestant({ sessionId: null })]))).toThrow(/no contestant has a session/);
  });
});

describe("factsAfterTurn", () => {
  test("adds this turn's files and reaches to the ones before it, each once", () => {
    const before = contestant({
      filesRead: ["/arena/run/c1/a.ts"],
      outsideReached: [{ path: "/arena/run/c2/x.md", how: "read", rival: "c2" }],
    });
    const rival = contestant({ contestantId: "c2", worktreePath: "/arena/run/c2", sessionId: "s2" });
    const facts = factsAfterTurn(
      before,
      [
        call("a", "Read", { file_path: "/arena/run/c1/a.ts" }),
        call("b", "Edit", { file_path: "/arena/run/c1/b.ts" }),
        call("c", "Read", { file_path: "/arena/run/c2/x.md" }),
        call("d", "Bash", { command: "cat ../c2/y.md" }),
      ],
      run([before, rival]),
      "/Users/me",
    );
    expect(facts).toEqual({
      filesRead: ["/arena/run/c1/a.ts", "/arena/run/c2/x.md"],
      filesWritten: ["/arena/run/c1/b.ts"],
      outsideReached: [
        { path: "/arena/run/c2/x.md", how: "read", rival: "c2" },
        { path: "/arena/run/c2/y.md", how: "shell", rival: "c2" },
      ],
    });
  });
});
