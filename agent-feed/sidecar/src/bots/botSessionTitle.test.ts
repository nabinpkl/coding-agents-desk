// Anchor plus bracket: the anchor never moves, the task says what the session is doing.
import { expect, test } from "bun:test";
import {
  formatBotSessionTitle,
  parseBotSessionTitle,
  refuseTaskText,
  stableSessionAnchor,
  taskFromText,
} from "@agentdesk/agent-feed-wire";

test("slot zero takes the Bot's name bare, later slots number past it", () => {
  expect(stableSessionAnchor("AD bot", 0)).toBe("AD bot");
  expect(stableSessionAnchor("AD bot", 1)).toBe("AD bot 2");
  expect(stableSessionAnchor("AD bot", 5)).toBe("AD bot 6");
});

test("an empty task leaves the bare anchor", () => {
  expect(formatBotSessionTitle("AD bot", "")).toBe("AD bot");
  expect(formatBotSessionTitle("AD bot 2", "Checkout flow")).toBe("AD bot 2 (Checkout flow)");
});

test("a title parses back into the halves it was made from", () => {
  expect(parseBotSessionTitle("AD bot 2 (Checkout flow)")).toEqual({ anchor: "AD bot 2", task: "Checkout flow" });
  expect(parseBotSessionTitle("AD bot")).toEqual({ anchor: "AD bot", task: "" });
  // Not a trailing bracket, so not a task half: the whole thing is the anchor.
  expect(parseBotSessionTitle("fix (urgent) bug")).toEqual({ anchor: "fix (urgent) bug", task: "" });
});

test("a task cannot carry line breaks or its own brackets", () => {
  expect(refuseTaskText("Checkout flow")).toBeNull();
  expect(refuseTaskText("line\nbreak")).not.toBeNull();
  expect(refuseTaskText("fix (urgent)")).not.toBeNull();
});

test("requested text reads its task against the anchor it will wear", () => {
  // Already bracketed under this anchor: the bracket is the task.
  expect(taskFromText("AD bot 2 (Checkout flow)", "AD bot 2")).toBe("Checkout flow");
  // Bracketed under a stale anchor: the task still names the work.
  expect(taskFromText("AD bot 9 (Checkout flow)", "AD bot 2")).toBe("Checkout flow");
  // An old title starting with the anchor normalizes instead of nesting.
  expect(taskFromText("AD bot familiarization", "AD bot")).toBe("familiarization");
  // A word boundary, not a prefix: ADX 7 is not AD plus a task.
  expect(taskFromText("ADX 7", "AD")).toBe("ADX 7");
  // Bare anchor, and nothing at all, both mean no task.
  expect(taskFromText("AD bot", "AD bot")).toBe("");
  expect(taskFromText("  ", "AD bot")).toBe("");
  // Anything else is the task whole.
  expect(taskFromText("Bot background color", "AD bot 2")).toBe("Bot background color");
});
