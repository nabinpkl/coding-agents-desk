// The remembered choice. Worth pinning because it is the one piece of the terminal composer that
// outlives the band: the Feed rebuilds that band whenever it re-reads a session's status. And
// because it is per session, the property that matters is what it does to the OTHER sessions --
// one flag for all of them is the bug this replaced.

import { beforeEach, expect, test, vi } from "vitest";
import {
  setTerminalComposerHeight,
  terminalComposerHeight,
  toggleTerminalComposer,
  type TerminalComposerSession,
} from "@/features/terminal/terminalComposerPreference";

const one: TerminalComposerSession = { source: "claude", sessionId: "one" };
const two: TerminalComposerSession = { source: "claude", sessionId: "two" };

function remembered(): unknown[] {
  return JSON.parse(localStorage.getItem("agent-panel.terminal-composer") ?? "[]") as unknown[];
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

// The height a reader drags the pane to. Same store as the toggle, because both answer "how did
// this reader arrange this session's pane" and two records could disagree about whether it exists.

test("a height written before a reload is the height after it", async () => {
  toggleTerminalComposer(one);
  setTerminalComposerHeight(one, 317);

  // A reload, faithfully: the module reads the store once, when it is first loaded, and the whole
  // point of writing the height down is that the second load finds it. Asserting through the
  // module already in memory would only be asserting that a variable was assigned.
  vi.resetModules();
  const reloaded = await import("@/features/terminal/terminalComposerPreference");
  expect(reloaded.terminalComposerHeight(one)).toBe(317);
});

test("the height rides with its own session and no other", () => {
  toggleTerminalComposer(one);
  toggleTerminalComposer(two);
  setTerminalComposerHeight(one, 240);
  expect(terminalComposerHeight(one)).toBe(240);
  expect(terminalComposerHeight(two)).toBeNull();
  expect(remembered()).toEqual([["claude:one", 240], "claude:two"]);
});

test("a session nobody dragged keeps the bare key, not a null height", () => {
  toggleTerminalComposer(one);
  expect(remembered()).toEqual(["claude:one"]);
});

// A reader hides the screen to get the transcript back for a moment and shows it again expecting
// the size they chose. A toggle that reset it undid the drag every time it was pressed.
test("hiding the pane and showing it again keeps its height", () => {
  toggleTerminalComposer(one);
  setTerminalComposerHeight(one, 240);
  toggleTerminalComposer(one);
  expect(terminalComposerHeight(one)).toBe(240);
  expect(remembered()).toEqual([["claude:one", 240, "hidden"]]);
  toggleTerminalComposer(one);
  expect(terminalComposerHeight(one)).toBe(240);
  expect(remembered()).toEqual([["claude:one", 240]]);
});

test("a hidden pane's height survives a reload, and the pane stays hidden", async () => {
  toggleTerminalComposer(one);
  setTerminalComposerHeight(one, 317);
  toggleTerminalComposer(one);

  vi.resetModules();
  const reloaded = await import("@/features/terminal/terminalComposerPreference");
  expect(reloaded.terminalComposerHeight(one)).toBe(317);
  reloaded.toggleTerminalComposer(one);
  expect(remembered()).toEqual([["claude:one", 317]]);
});

test("a hidden pane with a height still counts toward the cap", () => {
  toggleTerminalComposer(one);
  setTerminalComposerHeight(one, 240);
  toggleTerminalComposer(one);
  for (let index = 0; index < 64; index += 1) {
    toggleTerminalComposer({ source: "claude", sessionId: `s${index}` });
  }
  expect(remembered()).toHaveLength(64);
  expect(terminalComposerHeight(one)).toBeNull();
});

test("refuses a height for a pane that is not up", () => {
  // Only a pane that is up can be dragged, so a write for one that is not has lost track of it.
  setTerminalComposerHeight(one, 240);
  expect(remembered()).toEqual([]);
  expect(terminalComposerHeight(one)).toBeNull();
  toggleTerminalComposer(one);
  setTerminalComposerHeight(one, 240);
  toggleTerminalComposer(one);
  setTerminalComposerHeight(one, 500);
  expect(terminalComposerHeight(one)).toBe(240);
});

test("refuses a height that is not one", () => {
  toggleTerminalComposer(one);
  for (const bad of [0, -40, Number.NaN, Number.POSITIVE_INFINITY]) {
    setTerminalComposerHeight(one, bad);
  }
  expect(terminalComposerHeight(one)).toBeNull();
});

test("stores whole pixels, because that is what a drag is measured in", () => {
  toggleTerminalComposer(one);
  setTerminalComposerHeight(one, 240.6);
  expect(terminalComposerHeight(one)).toBe(241);
});

test("the oldest session out takes its height with it", () => {
  toggleTerminalComposer(one);
  setTerminalComposerHeight(one, 240);
  for (let index = 0; index < 64; index += 1) {
    toggleTerminalComposer({ source: "claude", sessionId: `s${index}` });
  }
  expect(remembered()).toHaveLength(64);
  expect(terminalComposerHeight(one)).toBeNull();
});

// The [key, mode] pair the three-state spell wrote lands in the same slot a height does. A mode is
// not a height, so it reads as a shown pane nobody has dragged rather than as a size.
test("a mode pair is a shown pane with no remembered height", async () => {
  localStorage.setItem(
    "agent-panel.terminal-composer",
    JSON.stringify([["claude:one", "echo"], ["claude:two", 240]]),
  );
  vi.resetModules();
  const reloaded = await import("@/features/terminal/terminalComposerPreference");
  expect(reloaded.terminalComposerHeight(one)).toBeNull();
  expect(reloaded.terminalComposerHeight(two)).toBe(240);
});
