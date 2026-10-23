// Who takes a run's next prompt, how a closed turn's facts add to the ones before it, what a turn's
// answer is, and when a pass may go.

import { describe, expect, test } from "bun:test";
import type { ArenaContestantRecord, ArenaRunRecord } from "@/arena/arenaRun";
import { ArenaNextPromptError, factsAfterTurn, lastAnswer, nextPromptContestants, passLanes } from "@/arena/arenaTurns";
import type { ActivityEvent } from "@/transcripts/transcriptTypes";

const contestant = (over: Partial<ArenaContestantRecord> = {}): ArenaContestantRecord => ({
  contestantId: "c1",
  source: "claude",
  model: null,
  stance: "for",
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
  answer: null,
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
    expect(nextPromptContestants(run([contestant(), failed, never])).map((one) => one.contestantId)).toEqual([
      "c1",
      "c2",
    ]);
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

/** One event of a turn: who wrote it, and its blocks. */
function said(type: ActivityEvent["type"], blocks: ActivityEvent["blocks"], humanTurn = false): ActivityEvent {
  return {
    id: `e${Math.random()}`,
    index: 0,
    revision: 1,
    phase: "complete",
    ts: 1,
    type,
    blocks,
    ...(humanTurn ? { humanTurn: true as const } : {}),
  };
}
const text = (value: string) => ({ kind: "text" as const, text: value });
const toolUse = { kind: "tool_use" as const, tool: "Read" };
const toolResult = { kind: "tool_result" as const, text: "file contents" };

describe("lastAnswer", () => {
  test("is what the latest turn said after its last tool call, earlier turns and narration left out", () => {
    const events = [
      said("user", [text("first prompt")], true),
      said("assistant", [text("first answer")]),
      said("user", [text("second prompt")], true),
      said("assistant", [text("Let me read the code."), toolUse]),
      said("user", [toolResult]),
      said("assistant", [text("The design:")]),
      said("assistant", [text("one loader, one manifest.")]),
    ];
    expect(lastAnswer(events)).toBe("The design:\n\none loader, one manifest.");
  });

  test("is everything the turn said when it said nothing after its last tool call", () => {
    const events = [
      said("user", [text("prompt")], true),
      said("assistant", [text("Writing it to DESIGN.md.")]),
      said("assistant", [toolUse]),
      said("user", [toolResult]),
    ];
    expect(lastAnswer(events)).toBe("Writing it to DESIGN.md.");
  });

  // A turn's own events (the serve's) may carry no flag; the prompt is then the user's text.
  test("finds the turn by a user's text when no event is flagged a person's, and is null for silence", () => {
    expect(lastAnswer([said("user", [text("prompt")]), said("assistant", [text("answer")])])).toBe("answer");
    expect(lastAnswer([said("user", [text("prompt")], true), said("assistant", [toolUse])])).toBeNull();
  });
});

describe("passLanes", () => {
  const settled = () =>
    run([
      contestant({ answer: "the design" }),
      contestant({
        contestantId: "c2",
        stance: "against",
        sessionId: "s2",
        tmuxSession: "pane-c2",
        answer: "it fails",
      }),
      contestant({ contestantId: "c3", sessionId: "s3", tmuxSession: "pane-c3" }),
    ]);

  test("answers the two lanes when they take different sides and the run has settled", () => {
    const { from, to } = passLanes(settled(), { from: "c1", to: "c2" });
    expect([from.contestantId, to.contestantId]).toEqual(["c1", "c2"]);
    expect(passLanes(settled(), { from: "c2", to: "c3" }).to.contestantId).toBe("c3");
  });

  test("refuses lanes on one side, a lane the run has not, and a lane with nothing to pass", () => {
    expect(() => passLanes(settled(), { from: "c1", to: "c3" })).toThrow(
      "between a lane for the prompt and a lane against it",
    );
    expect(() => passLanes(settled(), { from: "c1", to: "c9" })).toThrow('names "c9"');
    const silent = settled();
    silent.contestants[0]!.answer = null;
    expect(() => passLanes(silent, { from: "c1", to: "c2" })).toThrow("c1 has no answer to pass yet");
  });

  test("waits, as a prompt does, while any lane is still on its turn", () => {
    const busy = settled();
    busy.contestants[2]!.status = "running";
    try {
      passLanes(busy, { from: "c1", to: "c2" });
      throw new Error("a pass went while a lane was running");
    } catch (error) {
      expect(error).toBeInstanceOf(ArenaNextPromptError);
      expect((error as ArenaNextPromptError).busy).toBe(true);
    }
  });
});
