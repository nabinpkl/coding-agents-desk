import { describe, expect, it } from "bun:test";
import { currentWindowTokens, lastCompletedCompactionIndex } from "@/agents/opencode/opencodeServeCalls";

const assistant = (output: number, read: number) => ({
  type: "assistant",
  tokens: { input: 100, output, reasoning: 0, cache: { read, write: 0 } },
});

describe("currentWindowTokens", () => {
  it("reads the newest assistant message with tokens, not the session totals", () => {
    expect(
      currentWindowTokens([
        assistant(50, 1000),
        { type: "user" },
        assistant(216, 610929),
      ]),
    ).toBe(100 + 216 + 610929);
  });

  it("counts a running turn the TUI already shows, instead of holding the last finished one", () => {
    expect(
      currentWindowTokens([
        assistant(50, 1000),
        { type: "user" },
        // Streaming: input and cache reads land before any output does.
        { type: "assistant", tokens: { input: 629, output: 0, reasoning: 162, cache: { read: 219761, write: 0 } } },
      ]),
    ).toBe(629 + 0 + 162 + 219761);
  });

  it("reports nothing without a message carrying tokens", () => {
    expect(currentWindowTokens([{ type: "assistant", tokens: null }])).toBeNull();
    expect(currentWindowTokens([{ type: "assistant", tokens: { input: 0, output: 0 } }])).toBeNull();
    expect(currentWindowTokens([{ type: "user" }])).toBeNull();
    expect(currentWindowTokens([])).toBeNull();
  });
});

describe("lastCompletedCompactionIndex", () => {
  const completed = { type: "compaction", status: "completed" };

  it("ignores assistants at or before the boundary", () => {
    const before = assistant(216, 610929);
    const after = assistant(50, 1000);
    const messages = [before, { type: "user" }, completed, { type: "user" }, after];
    expect(lastCompletedCompactionIndex(messages)).toBe(2);
    // The pre-compaction 611K window is gone; only the post-boundary turn counts.
    expect(currentWindowTokens(messages)).toBe(100 + 50 + 1000);
  });

  it("blanks the gap: completed compaction with no tokens reported after it", () => {
    expect(
      currentWindowTokens([assistant(216, 610929), { type: "user" }, completed]),
    ).toBeNull();
  });

  it("a running or failed compaction moves no boundary", () => {
    const messages = [assistant(216, 610929), { type: "compaction", status: "running" }];
    expect(lastCompletedCompactionIndex(messages)).toBe(-1);
    expect(currentWindowTokens(messages)).toBe(100 + 216 + 610929);
    const failed = [assistant(216, 610929), { type: "compaction", status: "failed" }];
    expect(lastCompletedCompactionIndex(failed)).toBe(-1);
    expect(currentWindowTokens(failed)).toBe(100 + 216 + 610929);
  });

  it("the newest completed compaction wins", () => {
    const messages = [
      assistant(10, 10),
      completed,
      assistant(20, 20),
      { type: "compaction", status: "completed" },
    ];
    expect(lastCompletedCompactionIndex(messages)).toBe(3);
    expect(currentWindowTokens(messages)).toBeNull();
  });
});
