import { describe, expect, it } from "bun:test";
import { currentWindowTokens } from "@/agents/opencode/opencodeServeCalls";

const assistant = (output: number, read: number) => ({
  type: "assistant",
  tokens: { input: 100, output, reasoning: 0, cache: { read, write: 0 } },
});

describe("currentWindowTokens", () => {
  it("reads the last finished assistant turn, not the session totals", () => {
    expect(
      currentWindowTokens([
        assistant(50, 1000),
        { type: "user" },
        assistant(216, 610929),
      ]),
    ).toBe(100 + 216 + 610929);
  });

  it("skips turns with no output and reports nothing without one", () => {
    expect(currentWindowTokens([{ type: "assistant", tokens: { input: 5, output: 0 } }])).toBeNull();
    expect(currentWindowTokens([{ type: "user" }])).toBeNull();
    expect(currentWindowTokens([])).toBeNull();
  });
});
