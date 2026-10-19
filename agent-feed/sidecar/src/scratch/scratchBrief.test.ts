import { expect, test } from "bun:test";
import { splitScratchBrief } from "@agentdesk/agent-feed-wire";
import { scratchFirstTurn, scratchTitle } from "@/scratch/scratchBrief";

test("the first turn is the brief, then the message, and splits back into both", () => {
  const turn = scratchFirstTurn("/scratch/rust-async-1a2b", "How does tokio schedule tasks?");
  const split = splitScratchBrief(turn);
  expect(split?.rest).toBe("How does tokio schedule tasks?");
  expect(split?.brief).toContain("/scratch/rust-async-1a2b");
  expect(split?.brief).not.toContain("<agentdesk-scratch-brief>");
});

test("a message that mentions the closing marker keeps it, since the brief's comes first", () => {
  const turn = scratchFirstTurn("/scratch/x-0000", "What does </agentdesk-scratch-brief> mean?");
  expect(splitScratchBrief(turn)?.rest).toBe("What does </agentdesk-scratch-brief> mean?");
});

test("text that does not open with the brief is not split", () => {
  expect(splitScratchBrief("Hello <agentdesk-scratch-brief>")).toBeNull();
  expect(splitScratchBrief(" <agentdesk-scratch-brief>\nx\n</agentdesk-scratch-brief>")).toBeNull();
});

test("a brief cut short has no message after it", () => {
  expect(splitScratchBrief("<agentdesk-scratch-brief>\nThis chat was started")).toEqual({
    brief: "This chat was started",
    rest: "",
  });
});

test("a chat is named from the first line it was sent", () => {
  expect(scratchTitle("\n  Plan   the garden \nmore detail")).toBe("Plan the garden");
  expect(scratchTitle("   ")).toBe("Chat");
  const long = scratchTitle("Research the tradeoffs between three embedded databases for a desktop app that syncs");
  expect(long.length).toBeLessThanOrEqual(61);
  expect(long.endsWith("…")).toBe(true);
  expect(long).not.toContain("  ");
});
