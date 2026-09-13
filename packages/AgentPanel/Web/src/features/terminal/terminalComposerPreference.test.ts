// The remembered arrangement. Worth pinning because it is the one piece of the terminal composer
// that outlives the band: the Feed rebuilds that band whenever it re-reads a session's status. And
// because it is per session, the property that matters is what it does to the OTHER sessions --
// one flag for all of them is the bug this replaced.

import { beforeEach, expect, test } from "vitest";
import {
  cycleTerminalComposer,
  type TerminalComposerSession,
} from "@/features/terminal/terminalComposerPreference";

const one: TerminalComposerSession = { source: "claude", sessionId: "one" };
const two: TerminalComposerSession = { source: "claude", sessionId: "two" };

function remembered(): unknown[] {
  return JSON.parse(localStorage.getItem("agent-panel.terminal-composer") ?? "[]") as unknown[];
}

beforeEach(() => localStorage.clear());

// From the default, which is the field. The first press reaches the arrangement that hides
// nothing, and giving the field up is the deliberate second one.
test("walks field to echo to terminal and back to field", () => {
  cycleTerminalComposer(one);
  expect(remembered()).toEqual([["claude:one", "echo"]]);
  cycleTerminalComposer(one);
  expect(remembered()).toEqual([["claude:one", "terminal"]]);
  cycleTerminalComposer(one);
  expect(remembered()).toEqual([]);
});

test("one session's arrangement leaves every other session on its field", () => {
  cycleTerminalComposer(one);
  cycleTerminalComposer(two);
  cycleTerminalComposer(two);
  expect(remembered()).toEqual([["claude:one", "echo"], ["claude:two", "terminal"]]);
  cycleTerminalComposer(one);
  expect(remembered()).toEqual([["claude:two", "terminal"], ["claude:one", "terminal"]]);
});

// Two providers can hand out the same session id, so the source is part of the identity.
test("the same id under two sources is two sessions", () => {
  cycleTerminalComposer({ source: "claude", sessionId: "shared" });
  cycleTerminalComposer({ source: "codex", sessionId: "shared" });
  expect(remembered()).toEqual([["claude:shared", "echo"], ["codex:shared", "echo"]]);
});

test("drops the oldest choice rather than growing without bound", () => {
  for (let index = 0; index < 65; index += 1) {
    cycleTerminalComposer({ source: "claude", sessionId: `s${index}` });
  }
  const kept = remembered() as Array<[string, string]>;
  expect(kept).toHaveLength(64);
  expect(kept[0]![0]).toBe("claude:s1");
  expect(kept.at(-1)![0]).toBe("claude:s64");
});

// The two-state shape stored a bare key and meant "the terminal is up". That state still exists and
// still has a name, so it resolves to `terminal` rather than being discarded: the reader arranged
// something, and the next press continues from where they left off rather than starting over.
test("a session stored under the two-state shape resumes from the terminal", () => {
  localStorage.setItem("agent-panel.terminal-composer", JSON.stringify(["claude:one"]));
  cycleTerminalComposer(one);
  expect(remembered()).toEqual([]);
});

// The shape before THAT was the string "shown", which names no session. Unreadable remembers
// nothing, which costs one press, where decoding it wrongly would arrange a session at random.
test("a store it cannot read remembers nothing", () => {
  localStorage.setItem("agent-panel.terminal-composer", "shown");
  cycleTerminalComposer(one);
  expect(remembered()).toEqual([["claude:one", "echo"]]);
});
