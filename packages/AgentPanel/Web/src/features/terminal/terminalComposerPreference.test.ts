// The remembered choice. Worth pinning because it is the one piece of the terminal composer that
// outlives the band: the Feed rebuilds that band whenever it re-reads a session's status.

import { beforeEach, expect, test } from "vitest";
import { toggleTerminalComposer } from "./terminalComposerPreference";

beforeEach(() => localStorage.clear());

// From the default, which is the field: the first press asks for the terminal.
test("remembers being shown, and being hidden again", () => {
  toggleTerminalComposer();
  expect(localStorage.getItem("agent-panel.terminal-composer")).toBe("shown");
  toggleTerminalComposer();
  expect(localStorage.getItem("agent-panel.terminal-composer")).toBe("hidden");
});
