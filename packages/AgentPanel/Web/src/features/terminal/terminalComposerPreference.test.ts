// The remembered choice. Worth pinning because it is the one piece of the terminal composer that
// outlives the band: the Feed rebuilds that band whenever it re-reads a session's status. And
// because it is per session, the property that matters is what it does to the OTHER sessions --
// one flag for all of them is the bug this replaced.

import { beforeEach, expect, test } from "vitest";
import {
  toggleTerminalComposer,
  type TerminalComposerSession,
} from "@/features/terminal/terminalComposerPreference";

const one: TerminalComposerSession = { source: "claude", sessionId: "one" };
const two: TerminalComposerSession = { source: "claude", sessionId: "two" };

function remembered(): string[] {
  return JSON.parse(localStorage.getItem("agent-panel.terminal-composer") ?? "[]") as string[];
}

beforeEach(() => localStorage.clear());

// From the default, which is hidden: the first press puts the session's screen up.
test("remembers being shown, and being hidden again", () => {
  toggleTerminalComposer(one);
  expect(remembered()).toEqual(["claude:one"]);
  toggleTerminalComposer(one);
  expect(remembered()).toEqual([]);
});

test("one session's screen leaves every other session's hidden", () => {
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

// The three-state spell wrote a [key, mode] pair, and BOTH of its modes were ways of having the
// pane up. So a session stored that way is on, and one press turns it off -- a reader finds what
// they arranged still arranged rather than silently back at the default.
test("a session stored as a mode pair is simply shown", () => {
  localStorage.setItem("agent-panel.terminal-composer", JSON.stringify([["claude:one", "echo"]]));
  toggleTerminalComposer(one);
  expect(remembered()).toEqual([]);
  toggleTerminalComposer(one);
  expect(remembered()).toEqual(["claude:one"]);
});

test("the other mode of that pair resolves the same way", () => {
  localStorage.setItem("agent-panel.terminal-composer", JSON.stringify([["claude:one", "terminal"]]));
  toggleTerminalComposer(one);
  expect(remembered()).toEqual([]);
});

// The shape before those was the string "shown", which names no session. Unreadable remembers
// nothing, which costs one press, where decoding it wrongly would open a pane on a session at random.
test("a store it cannot read remembers nothing", () => {
  localStorage.setItem("agent-panel.terminal-composer", "shown");
  toggleTerminalComposer(one);
  expect(remembered()).toEqual(["claude:one"]);
});
