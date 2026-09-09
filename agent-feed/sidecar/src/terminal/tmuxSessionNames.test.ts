// The names are display, so what is worth pinning is what they must SURVIVE: a shell that globs,
// tmux's target syntax, and a person typing one from memory.

import { expect, test } from "bun:test";
import { tmuxSessionSlug, uniqueTmuxSessionName } from "./tmuxSessionNames.ts";

test("the title a shell could not hold becomes one it can", () => {
  // The exact title behind `invalid mode specification`: zsh read `(fork 1)` as a glob qualifier
  // and started nothing. Nothing outside [a-z0-9-] survives, so there is nothing left to glob.
  expect(tmuxSessionSlug("Canvas session (fork 1)")).toBe("canvas-session-fork-1");
});

test("tmux's own target punctuation cannot reach the name", () => {
  // `:` and `.` end a session name in `session:window.pane`, so a name carrying either addresses
  // something other than itself.
  expect(tmuxSessionSlug("build: v1.2 rollout")).toBe("build-v1-2-rollout");
  expect(tmuxSessionSlug("a.b:c")).toBe("a-b-c");
});

test("a name never leads, trails, or doubles its separator", () => {
  expect(tmuxSessionSlug("  ...Windows canvas!!  ")).toBe("windows-canvas");
  expect(tmuxSessionSlug("AD  --  Project   manager")).toBe("ad-project-manager");
});

// A name that is empty or all punctuation would otherwise become "" or a bare suffix, and
// `tmux -t ''` is not a session anyone can reach.
test("a title with nothing usable in it still yields a name", () => {
  expect(tmuxSessionSlug("")).toBe("session");
  expect(tmuxSessionSlug("!!! ---")).toBe("session");
  expect(tmuxSessionSlug("   ")).toBe("session");
});

test("a long title is cut on a word boundary, not mid-word", () => {
  const slug = tmuxSessionSlug("report claude usage beside codex in tabs with quota");
  expect(slug.length).toBeLessThanOrEqual(32);
  expect(slug).toBe("report-claude-usage-beside-codex");
  // Ends on a whole word: the cut landed on a boundary rather than inside `codex`.
  expect(slug.endsWith("-")).toBe(false);
});

test("a single word longer than the limit is cut rather than emptied", () => {
  // No boundary to cut on, so the early-boundary guard must not throw the whole name away.
  const slug = tmuxSessionSlug("a".repeat(50));
  expect(slug).toBe("a".repeat(32));
});

test("an unclaimed name carries no suffix", () => {
  // The common case, and the reason the suffix is conditional: most titles here are unique, and
  // the bare name is what a reader can type.
  expect(uniqueTmuxSessionName("Canvas session", "b18b005e-46ad", ["claude-usage"]))
    .toBe("canvas-session");
});

test("the second session of the same title is told apart by its own id", () => {
  // Six sessions were called "Windows canvas" on one night. The id decides rather than arrival
  // order, so a session keeps its name across restarts instead of depending on who started first.
  expect(uniqueTmuxSessionName("Windows canvas", "b18b005e-46ad", ["windows-canvas"]))
    .toBe("windows-canvas-b18b00");
});

test("ids sharing a prefix still get separate names", () => {
  // Terminates on the full id rather than searching for a longer prefix.
  const taken = ["windows-canvas", "windows-canvas-b18b00"];
  expect(uniqueTmuxSessionName("Windows canvas", "b18b005e-46ad", taken))
    .toBe("windows-canvas-b18b005e-46ad");
});

test("two different titles never need a suffix to differ", () => {
  const taken = ["canvas-session"];
  expect(uniqueTmuxSessionName("Terminal tiles", "aaaaaaaa", taken)).toBe("terminal-tiles");
});
