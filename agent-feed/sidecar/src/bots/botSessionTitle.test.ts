// Anchor plus bracket: the anchor never moves, the task says what the session is doing.
import { expect, test } from "bun:test";
import {
  ANCHOR_POOLS,
  backfillTaskText,
  firstFreeAnchor,
  formatBotSessionTitle,
  parseBotSessionTitle,
  refuseTaskText,
  taskFromText,
} from "@agentdesk/agent-feed-wire";

const people = ANCHOR_POOLS.people!;
const trees = ANCHOR_POOLS.trees!;

test("allocation is first-free, deterministic, and never reuses", () => {
  expect(firstFreeAnchor([], people)).toBe("Aaron");
  expect(firstFreeAnchor(["Aaron", "Adam"], people)).toBe("Alan");
  // A freed name stays spent: the set is history, not occupancy.
  expect(firstFreeAnchor(["Adam"], people)).toBe("Aaron");
});

test("two machines on two pools never hand out one name, laps included", () => {
  const all = Object.values(ANCHOR_POOLS).flat();
  expect(new Set(all).size).toBe(all.length);
  expect(firstFreeAnchor([], trees)).toBe("Acacia");
  // Past the end of a pool the laps stay in that pool's names.
  expect(firstFreeAnchor(trees, trees)).toBe("Acacia 2");
  expect(firstFreeAnchor(people, people)).toBe("Aaron 2");
});

test("an empty task leaves the bare anchor", () => {
  expect(formatBotSessionTitle("Aaron", "")).toBe("Aaron");
  expect(formatBotSessionTitle("Aaron", "Checkout flow")).toBe("Aaron (Checkout flow)");
});

test("a title parses back into the halves it was made from", () => {
  expect(parseBotSessionTitle("Aaron (Checkout flow)")).toEqual({ anchor: "Aaron", task: "Checkout flow" });
  expect(parseBotSessionTitle("Aaron")).toEqual({ anchor: "Aaron", task: "" });
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
  expect(taskFromText("Aaron (Checkout flow)", "Aaron")).toBe("Checkout flow");
  // Bracketed under a stale anchor: the task still names the work.
  expect(taskFromText("Maya (Checkout flow)", "Aaron")).toBe("Checkout flow");
  // An old title starting with the anchor normalizes instead of nesting.
  expect(taskFromText("Chatbot extraction", "Chatbot")).toBe("extraction");
  // A word boundary, not a prefix: ADX 7 is not AD plus a task.
  expect(taskFromText("ADX 7", "AD")).toBe("ADX 7");
  // Bare anchor, and nothing at all, both mean no task.
  expect(taskFromText("Aaron", "Aaron")).toBe("");
  expect(taskFromText("  ", "Aaron")).toBe("");
  // Anything else is the task whole.
  expect(taskFromText("Give each card a colour.", "Maya")).toBe("Give each card a colour.");
});

test("an old title backfills to its task without its old suffixes", () => {
  expect(backfillTaskText("Latest state review (fork #1)")).toBe("Latest state review");
  expect(backfillTaskText("Workspace IDE Vite and Bun watch")).toBe("Workspace IDE Vite and Bun watch");
  expect(backfillTaskText("AD bot")).toBe("AD bot");
});
