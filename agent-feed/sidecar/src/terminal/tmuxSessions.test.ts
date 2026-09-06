import { expect, test } from "bun:test";
import { historyForTerminal, parseTmuxSessions, TmuxUnavailable } from "./tmuxSessions.ts";

test("reads one session per line in the order tmux listed them", () => {
  expect(parseTmuxSessions(
    "canvas-fork|1|0|/Users/dev/projects/agent-desk\nkeyboard|3|2|/Users/dev/projects/other\n",
  )).toEqual([
    { name: "canvas-fork", windows: 1, attachedClients: 0, path: "/Users/dev/projects/agent-desk" },
    { name: "keyboard", windows: 3, attachedClients: 2, path: "/Users/dev/projects/other" },
  ]);
});

test("an empty listing is an empty machine, not a failure", () => {
  expect(parseTmuxSessions("")).toEqual([]);
  expect(parseTmuxSessions("\n\n")).toEqual([]);
});

test("a line missing a field is format drift and says so", () => {
  // Silently skipping it would render a grid with a tile absent and no reason given.
  expect(() => parseTmuxSessions("canvas-fork|1|0\n")).toThrow(TmuxUnavailable);
});

test("returns the column as well as the row, because a terminal needs telling", () => {
  // A bare LF moves down and stays in the same column, so captured lines arrive as a staircase:
  // each one indented by the length of the line above it.
  expect(historyForTerminal("one\ntwo\nthree\n")).toBe("one\r\ntwo\r\nthree\r\n");
});

test("leaves a line that already ends properly alone, rather than doubling it", () => {
  expect(historyForTerminal("one\r\ntwo\r\n")).toBe("one\r\ntwo\r\n");
});

test("keeps the escapes that carry the colour", () => {
  expect(historyForTerminal("\u001b[31mred\u001b[0m\n")).toBe("\u001b[31mred\u001b[0m\r\n");
});
