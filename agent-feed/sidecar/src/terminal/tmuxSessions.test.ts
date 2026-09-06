import { expect, test } from "bun:test";
import {
  captureHistoryArgs,
  captureScreenArgs,
  paneHeightArgs,
  historyForTerminal,
  parseTmuxSessions,
  terminalHistoryPayload,
  TmuxUnavailable,
} from "./tmuxSessions.ts";

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

test("asks for the scrollback and stops one line short of the screen", () => {
  // `-E -1` is the whole guarantee: the screen belongs to the live stream, and a capture that
  // included it would hand the viewer a frozen second copy of the rows the live stream then
  // repaints. Losing this flag reintroduces half-overwritten history lines, which read as
  // corruption rather than as a range bug, so it is pinned here.
  expect(captureHistoryArgs("keyboard", 50_000)).toEqual([
    "capture-pane", "-p", "-e", "-S", "-50000", "-E", "-1", "-t", "keyboard",
  ]);
});

test("captures the screen separately, with no range, so the two do not overlap", () => {
  expect(captureScreenArgs("keyboard")).toEqual(["capture-pane", "-p", "-e", "-t", "keyboard"]);
  expect(paneHeightArgs("keyboard"))
    .toEqual(["display-message", "-p", "-t", "keyboard", "#{pane_height}"]);
});

test("opens exactly one screen of rows between the history and the screen", () => {
  // The count is the alignment. One row too few and tmux's next repaint lands inside the last
  // history line; one too many and the screen sits below the window it is meant to fill. Counting
  // from the payload is the only way to see either, since both render as plausible-looking text.
  const payload = terminalHistoryPayload({
    scrollback: "old one\nold two\n",
    screen: "top\nmiddle\nbottom\n",
    rows: 3,
  });
  expect(payload).toBe("old one\r\nold two\r\n\r\n\r\n\u001b[Htop\r\nmiddle\r\nbottom");
});

test("the rows it opens follow the pane's height, since that is what has to line up", () => {
  const opening = (rows: number): string =>
    terminalHistoryPayload({ scrollback: "one\n", screen: "s\n", rows })
      .slice("one\r\n".length, -"\u001b[Hs".length);
  expect(opening(1)).toBe("");
  expect(opening(2)).toBe("\r\n");
  expect(opening(24)).toBe("\r\n".repeat(23));
});

test("still opens a full screen when the pane has no scrollback at all", () => {
  expect(terminalHistoryPayload({ scrollback: "", screen: "only\n", rows: 2 }))
    .toBe("\r\n\u001b[Honly");
});
