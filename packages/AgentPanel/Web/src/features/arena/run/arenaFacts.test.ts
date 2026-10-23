import { describe, expect, test } from "vitest";
import type { ArenaContestantDetail } from "@agentdesk/agent-feed-wire";
import {
  diffStat,
  elapsedMs,
  fileMatrix,
  formatDuration,
  relativeToWorktree,
  splitDiff,
} from "@/features/arena/run/arenaFacts";

const contestant = (over: Partial<ArenaContestantDetail> = {}): ArenaContestantDetail => ({
  contestantId: "c1",
  stance: "for",
  source: "opencode",
  model: null,
  sessionId: "s1",
  worktreePath: "/arena/run/c1",
  tmuxSession: null,
  status: "closed",
  startedAt: 1_000,
  closedAt: 6_000,
  durationMs: 5_000,
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

const DIFF = [
  "diff --git a/src/widget.ts b/src/widget.ts",
  "index 152b480..80a772b 100644",
  "--- a/src/widget.ts",
  "+++ b/src/widget.ts",
  "@@ -1 +1,2 @@",
  "-export const widget = 1;",
  "+export const widget = 2;",
  "+export const gadget = 3;",
  "diff --git a/README.md b/README.md",
  "--- a/README.md",
  "+++ b/README.md",
  "@@ -1 +1 @@",
  "-Widget",
  "+Widgets",
].join("\n");

describe("relativeToWorktree", () => {
  test("strips the contestant's own worktree, in either spelling of /tmp", () => {
    expect(relativeToWorktree("/arena/run/c1/src/a.ts", "/arena/run/c1")).toBe("src/a.ts");
    expect(relativeToWorktree("/private/tmp/r/c1/a.ts", "/tmp/r/c1")).toBe("a.ts");
    expect(relativeToWorktree("/tmp/r/c1/a.ts", "/private/tmp/r/c1")).toBe("a.ts");
  });

  test("leaves a path outside the worktree whole, and never strips a sibling's prefix", () => {
    expect(relativeToWorktree("/etc/hosts", "/arena/run/c1")).toBe("/etc/hosts");
    expect(relativeToWorktree("/arena/run/c10/a.ts", "/arena/run/c1")).toBe("/arena/run/c10/a.ts");
  });
});

describe("fileMatrix", () => {
  test("lines the same repository file up across lanes, whatever worktree it was read in", () => {
    const rows = fileMatrix([
      contestant({ filesRead: ["/arena/run/c1/README.md"], filesWritten: ["/arena/run/c1/src/a.ts"] }),
      contestant({
        contestantId: "c2",
        worktreePath: "/arena/run/c2",
        filesRead: ["/arena/run/c2/README.md", "/arena/run/c2/src/a.ts"],
        filesWritten: ["/arena/run/c2/src/a.ts"],
      }),
    ]);
    expect(rows.map((row) => [row.path, row.touches])).toEqual([
      ["README.md", ["read", "read"]],
      ["src/a.ts", ["written", "both"]],
    ]);
  });

  test("files outside the repository sort after the ones inside it", () => {
    const rows = fileMatrix([contestant({ filesRead: ["/home/me/notes.md", "/arena/run/c1/z.ts"] })]);
    expect(rows.map((row) => [row.path, row.inRepository])).toEqual([
      ["z.ts", true],
      ["/home/me/notes.md", false],
    ]);
  });
});

describe("splitDiff", () => {
  test("one part per file, counting hunk lines and never the headers", () => {
    const parts = splitDiff(DIFF);
    expect(parts.map((part) => [part.path, part.added, part.removed])).toEqual([
      ["src/widget.ts", 2, 1],
      ["README.md", 1, 1],
    ]);
    expect(parts[1]?.text.startsWith("diff --git a/README.md")).toBe(true);
    expect(diffStat(DIFF)).toEqual({ added: 3, removed: 2, files: 2 });
  });

  test("an empty or missing diff is no files and no lines", () => {
    expect(diffStat("")).toEqual({ added: 0, removed: 0, files: 0 });
    expect(diffStat(null)).toEqual({ added: 0, removed: 0, files: 0 });
  });
});

describe("durations", () => {
  test("a closed contestant reads its recorded time; a running one reads the clock", () => {
    expect(elapsedMs(contestant(), 99_999)).toBe(5_000);
    expect(elapsedMs(contestant({ durationMs: null, closedAt: null }), 4_000)).toBe(3_000);
    expect(elapsedMs(contestant({ durationMs: null, startedAt: null, closedAt: null }), 4_000)).toBeNull();
  });

  test("tenths under a minute, minutes and seconds past it", () => {
    expect(formatDuration(9_286)).toBe("9.3s");
    expect(formatDuration(125_000)).toBe("2m 05s");
  });
});
