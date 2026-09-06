import { expect, test } from "bun:test";
import {
  captureHistoryArgs,
  captureScreenArgs,
  hasSessionArgs,
  newSessionArgs,
  paneGeometryArgs,
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
  expect(paneGeometryArgs("keyboard"))
    .toEqual(["display-message", "-p", "-t", "keyboard", "#{pane_height} #{cursor_y} #{cursor_x}"]);
});

test("opens exactly one screen of rows between the history and the screen", () => {
  // The count is the alignment. One row too few and tmux's next repaint lands inside the last
  // history line; one too many and the screen sits below the window it is meant to fill. Counting
  // from the payload is the only way to see either, since both render as plausible-looking text.
  const payload = terminalHistoryPayload({
    scrollback: "old one\nold two\n",
    screen: "top\nmiddle\nbottom\n",
    rows: 3,
    cursor: { row: 0, column: 0 },
  });
  expect(payload)
    .toBe("old one\r\nold two\r\n\r\n\r\n\u001b[Htop\r\nmiddle\r\nbottom\u001b[1;1H");
});

test("the rows it opens follow the pane's height, since that is what has to line up", () => {
  const opening = (rows: number): string =>
    terminalHistoryPayload({ scrollback: "one\n", screen: "s\n", rows, cursor: { row: 0, column: 0 } })
      .slice("one\r\n".length, -"\u001b[Hs\u001b[1;1H".length);
  expect(opening(1)).toBe("");
  expect(opening(2)).toBe("\r\n");
  expect(opening(24)).toBe("\r\n".repeat(23));
});

test("still opens a full screen when the pane has no scrollback at all", () => {
  expect(terminalHistoryPayload({ scrollback: "", screen: "only\n", rows: 2, cursor: { row: 0, column: 0 } }))
    .toBe("\r\n\u001b[Honly\u001b[1;1H");
});

test("leaves the cursor where the pane's is, not where the screen text ran out", () => {
  // The bug: the program on the other end redraws relative to the cursor, so an import that ended
  // below the composer echoed every later keystroke onto the status divider. tmux counts from 0
  // and CUP counts from 1.
  const payload = terminalHistoryPayload({
    scrollback: "",
    screen: "a\nb\nc\n",
    rows: 3,
    cursor: { row: 1, column: 4 },
  });
  expect(payload.endsWith("\u001b[2;5H")).toBe(true);
});

test("asks about a session by exact name", () => {
  // `=` matters: a bare `-t` resolves by exact name, then PREFIX, then fnmatch, so the answer for
  // `agentdesk-1` would be yes while `agentdesk-12` is what exists -- and this answer decides
  // whether to create a session or attach one somebody else is using.
  expect(hasSessionArgs("agentdesk-1")).toEqual(["has-session", "-t", "=agentdesk-1"]);
});

test("starts a session at the viewer's geometry, through a login shell that outlives it", () => {
  expect(newSessionArgs({
    session: "agentdesk-abc",
    cwd: "/Users/dev/projects/agent desk",
    command: ["claude", "--resume", "abc"],
    columns: 100,
    rows: 30,
  })).toEqual([
    // `-A`: a second create for the same name is a no-op rather than a duplicate-session error.
    "new-session", "-A", "-d", "-s", "agentdesk-abc",
    // Its own argument, so a path with a space in it needs no quoting.
    "-c", "/Users/dev/projects/agent desk",
    // Without these a detached session sits at 80x24 for life, whatever the viewer is.
    "-x", "100", "-y", "30",
    // A login shell because tmux runs a shell-command through `/bin/sh -c`, and this process's
    // environment is stripped of the PATH that finds `claude`. It stays after the command exits so
    // a refused resume leaves its reason on screen.
    "/bin/zsh -l -c 'claude --resume abc; exec /bin/zsh -l'",
  ]);
});
