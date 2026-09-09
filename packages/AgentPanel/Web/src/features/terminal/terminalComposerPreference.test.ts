// The remembered choice. Worth pinning because it is the one piece of the terminal composer that
// outlives the band: the Feed rebuilds that band whenever it re-reads a session's status. And
// because it is per session, the property that matters is what it does to the OTHER sessions --
// one flag for all of them is the bug this replaced.

import { beforeEach, expect, test } from "vitest";
import {
  toggleTerminalComposer,
  type TerminalComposerSession,
} from "./terminalComposerPreference";

const one: TerminalComposerSession = { source: "claude", sessionId: "one" };
const two: TerminalComposerSession = { source: "claude", sessionId: "two" };

function remembered(): string[] {
  return JSON.parse(localStorage.getItem("agent-panel.terminal-composer") ?? "[]") as string[];
}

beforeEach(() => localStorage.clear());

// From the default, which is the field: the first press asks for the terminal.
test("remembers being shown, and being hidden again", () => {
  toggleTerminalComposer(one);
  expect(remembered()).toEqual(["claude:one"]);
  toggleTerminalComposer(one);
  expect(remembered()).toEqual([]);
});

test("one session's terminal leaves every other session on its field", () => {
  toggleTerminalComposer(one);
  expect(remembered()).toEqual(["claude:one"]);
  toggleTerminalComposer(two);
  expect(remembered()).toEqual(["claude:one", "claude:two"]);
  toggleTerminalComposer(one);
  expect(remembered()).toEqual(["claude:two"]);
});

// Two providers can hand out the same session id, so the source is part of the identity.
test("the same id under two sources is two sessions", () => {
  toggleTerminalComposer({ source: "claude", sessionId: "shared" });
  toggleTerminalComposer({ source: "codex", sessionId: "shared" });
  expect(remembered()).toEqual(["claude:shared", "codex:shared"]);
});

test("drops the oldest choice rather than growing without bound", () => {
  for (let index = 0; index < 65; index += 1) {
    toggleTerminalComposer({ source: "claude", sessionId: `s${index}` });
  }
  const kept = remembered();
  expect(kept).toHaveLength(64);
  expect(kept[0]).toBe("claude:s1");
  expect(kept.at(-1)).toBe("claude:s64");
});

// The old shape was the string "shown". It is not migrated: an unreadable store remembers nothing,
// which costs one press, where decoding it wrongly would open a terminal on a session at random.
test("a store it cannot read remembers nothing", () => {
  localStorage.setItem("agent-panel.terminal-composer", "shown");
  toggleTerminalComposer(one);
  expect(remembered()).toEqual(["claude:one"]);
});
