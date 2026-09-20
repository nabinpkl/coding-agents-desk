import { expect, test } from "bun:test";
import { noServerRunning, noSuchSession } from "@/terminal/tmux/tmuxCommand";
import {
  waitForPaneToSettle,
  captureHistoryArgs,
  captureScreenArgs,
  hasSessionArgs,
  parseTmuxSessionIdentities,
  renameSessionArgs,
  setSessionIdentityArgs,
  newSessionArgs,
  paneDescriptionArgs,
  paneGeometryArgs,
  parsePaneDescription,
  historyForTerminal,
  fullBleedCapture,
  parseTmuxSessions,
  terminalHistoryPayload,
  TmuxUnavailable,
} from "@/terminal/tmux/tmuxSessions";

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
    .toEqual([
      "display-message", "-p", "-t", "keyboard",
      "#{pane_height} #{cursor_y} #{cursor_x} #{alternate_on}",
    ]);
});

test("reads the pane's mouse mode, which is what says the wheel may be forwarded", () => {
  // Both flags or nothing. `mouse_any_flag` alone means the program wants reports in an encoding
  // this repo does not send, and an SGR report it cannot read arrives as text rather than being
  // refused. Measured on a peer running Claude Code with `"tui": "fullscreen"`: 1 and 1.
  expect(parsePaneDescription("1848157|80|24|1|1\n").mouseReporting).toBe(true);
  expect(parsePaneDescription("1848157|80|24|1|0\n").mouseReporting).toBe(false);
  expect(parsePaneDescription("1848157|80|24|0|1\n").mouseReporting).toBe(false);
  expect(parsePaneDescription("62756|80|24|0|0\n"))
    .toEqual({ pid: 62756, columns: 80, rows: 24, mouseReporting: false });
});

test("refuses a pane description it cannot read rather than reporting a plausible one", () => {
  // An unreadable answer used to be a shorter one, and the fields it lost were the mouse flags at
  // the end. Falling back to false there would report every fullscreen pane as un-scrollable.
  expect(() => parsePaneDescription("1848157|80|24")).toThrow(TmuxUnavailable);
  expect(() => parsePaneDescription("|80|24|1|1")).toThrow(TmuxUnavailable);
});

test("asks tmux for the mouse flags in the same query as the geometry", () => {
  expect(paneDescriptionArgs("rags")).toEqual([
    "display-message", "-p", "-t", "rags",
    "#{pane_pid}|#{pane_width}|#{pane_height}|#{mouse_any_flag}|#{mouse_sgr_flag}",
  ]);
});

test("hands an alternate screen over as one, since there is no history to sit above it", () => {
  // tmux keeps no scrollback for the alternate screen, so the opening rows this payload normally
  // writes would be positioning a screen against history that cannot exist. What the viewer needs
  // instead is the mode itself: `pipe-pane` starts at now, so the `ESC[?1049h` that put the
  // program there was written at its startup and is never sent again, and a viewer that never
  // hears it paints a fullscreen program into its own scrollback and scrolls an empty buffer.
  expect(terminalHistoryPayload({
    scrollback: "",
    screen: "top\nmiddle\nbottom\n",
    rows: 3,
    cursor: { row: 2, column: 6 },
    alternateScreen: true,
  })).toBe("\u001b[?1049h\u001b[H\u001b[0mtop\u001b[K\r\n\u001b[0mmiddle\u001b[K\r\n\u001b[0mbottom\u001b[K\u001b[3;7H");
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
    .toBe("\u001b[0mold one\u001b[K\r\n\u001b[0mold two\u001b[K\r\n\r\n\r\n\u001b[H\u001b[0mtop\u001b[K\r\n\u001b[0mmiddle\u001b[K\r\n\u001b[0mbottom\u001b[K\u001b[1;1H");
});

test("the rows it opens follow the pane's height, since that is what has to line up", () => {
  const opening = (rows: number): string =>
    terminalHistoryPayload({ scrollback: "one\n", screen: "s\n", rows, cursor: { row: 0, column: 0 } })
      .slice("\u001b[0mone\u001b[K\r\n".length, -"\u001b[H\u001b[0ms\u001b[K\u001b[1;1H".length);
  expect(opening(1)).toBe("");
  expect(opening(2)).toBe("\r\n");
  expect(opening(24)).toBe("\r\n".repeat(23));
});

test("still opens a full screen when the pane has no scrollback at all", () => {
  expect(terminalHistoryPayload({ scrollback: "", screen: "only\n", rows: 2, cursor: { row: 0, column: 0 } }))
    .toBe("\r\n\u001b[H\u001b[0monly\u001b[K\u001b[1;1H");
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

test("a trimmed row keeps its colours to the margin, which is what the trim took", () => {
  // `capture-pane` trims trailing cells, so a row the program painted edge to edge arrives
  // ending where its text ends -- often with a background still open, the spaces it covered
  // trimmed away but the code that covered them kept. The erase fills exactly those cells
  // back in, in that background, with no width to count and nothing that can wrap.
  expect(fullBleedCapture("text\u001b[48;2;40;44;52m\n")).toBe("\u001b[0mtext\u001b[48;2;40;44;52m\u001b[K\r\n");
});

test("one row's trailing colours never smear into the next row's default cells", () => {
  // Without the reset, the row above's still-open background would paint the plain indent
  // below it -- grey where the pane holds the theme's own. Each row starts clean and sets
  // whatever the capture says, which is the row's first cell either way.
  expect(fullBleedCapture("top\u001b[48;2;40;44;52m\n   plain\n"))
    .toBe("\u001b[0mtop\u001b[48;2;40;44;52m\u001b[K\r\n\u001b[0m   plain\u001b[K\r\n");
});

test("a row the trim emptied is filled from the card continuing below it", () => {
  // A full-bleed background row trims to zero bytes -- not even its colours survive -- so
  // there is nothing to continue. The next row that still has colours says what the gap
  // was: its leading run is the background the whole width was painted.
  expect(fullBleedCapture("top\u001b[48;2;1;2;3m\n\n\u001b[48;2;1;2;3mnext\n"))
    .toBe("\u001b[0mtop\u001b[48;2;1;2;3m\u001b[K\r\n\u001b[48;2;1;2;3m\u001b[K\r\n\u001b[0m\u001b[48;2;1;2;3mnext\u001b[K\r\n");
});

test("a gap above default cells stays default rather than borrowing from above", () => {
  // The row below starts with plain text, so its first cell is the theme's own -- and so
  // is the gap. Bare inherits whatever the row above left, which the reset just made
  // explicit, so nothing is emitted at all.
  expect(fullBleedCapture("top\u001b[48;2;1;2;3m\n\nplain\n"))
    .toBe("\u001b[0mtop\u001b[48;2;1;2;3m\u001b[K\r\n\r\n\u001b[0mplain\u001b[K\r\n");
});

test("rows past the last content stay the theme's own", () => {
  // Nothing below has colours, so there is nothing to fill from. Bare, inheriting the
  // reset row above -- which is the bottom of the screen staying default, not a gap to fix.
  expect(fullBleedCapture("only\n\n")).toBe("\u001b[0monly\u001b[K\r\n\r\n");
});

test("asks about a session by exact name", () => {
  // `=` matters: a bare `-t` resolves by exact name, then PREFIX, then fnmatch, so the answer for
  // `agentdesk-1` would be yes while `agentdesk-12` is what exists -- and this answer decides
  // whether to create a session or attach one somebody else is using.
  expect(hasSessionArgs("agentdesk-1")).toEqual(["has-session", "-t", "=agentdesk-1"]);
});

test("starts a session at the viewer's geometry, through a login shell that outlives it", () => {
  const args = newSessionArgs({
    session: "agentdesk-abc",
    cwd: "/Users/dev/projects/agent desk",
    command: ["claude", "--resume", "abc"],
    columns: 100,
    rows: 30,
  });

  expect(args.slice(0, -1)).toEqual([
    // `-A`: a second create for the same name is a no-op rather than a duplicate-session error.
    "new-session", "-A", "-d", "-s", "agentdesk-abc",
    // Its own argument, so a path with a space in it needs no quoting.
    "-c", "/Users/dev/projects/agent desk",
    // Without these a detached session sits at 80x24 for life, whatever the viewer is.
    "-x", "100", "-y", "30",
  ]);
  // A login shell because tmux runs a shell-command through `/bin/sh -c`, and this process's
  // environment is stripped of the PATH that finds `claude`. It stays after the command exits so
  // a refused resume leaves its reason on screen.
  //
  // How the command inside is quoted is deliberately not asserted here. It is read by two shells
  // in turn, so the spelling is not the contract -- what arrives is, and the test below runs it.
  expect(args.at(-1)).toStartWith("/bin/zsh -l -c ");
  expect(args.at(-1)).toEndWith("; exec /bin/zsh -l'");
});

test("an argument survives the two shells it is flattened through, whatever is in it", () => {
  // The property, not the spelling: this string is read by `/bin/sh -c` and then by `zsh -l -c`,
  // so asserting how it is quoted asserts nothing about whether it arrives. A session title is the
  // first argument here that is not a bare token, and both of these broke before it existed --
  // zsh read the `(fork 1)` as a glob qualifier and answered "invalid mode specification", and an
  // apostrophe left the shell inside an unterminated quote.
  const argvFrom = (command: string[]): { out: string; code: number | null } => {
    const script = newSessionArgs({
      session: "s", cwd: "/tmp", command, columns: 80, rows: 24,
    }).at(-1)!;
    const spawned = Bun.spawnSync([
      "/bin/sh", "-c", script.replace("; exec /bin/zsh -l", ""),
    ]);
    return { out: new TextDecoder().decode(spawned.stdout), code: spawned.exitCode };
  };

  expect(argvFrom(["/bin/echo", "-n", "Canvas session (fork 1)"]))
    .toEqual({ out: "Canvas session (fork 1)", code: 0 });
  expect(argvFrom(["/bin/echo", "-n", "it's a $HOME; `boom`"]))
    .toEqual({ out: "it's a $HOME; `boom`", code: 0 });
});

test("waits until a pane stops changing, then attaches", async () => {
  // A pane that writes, writes again, then goes quiet: the wait ends after the quiet window rather
  // than at the first sample that happens to match.
  const samples = ["0 0 0", "3 1 0", "3 1 0", "9 4 2", "9 4 2", "9 4 2", "9 4 2"];
  let index = 0;
  let clock = 0;
  const result = await waitForPaneToSettle("pane", {
    quietMs: 200,
    pollMs: 100,
    timeoutMs: 5_000,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    sample: async () => samples[Math.min(index++, samples.length - 1)]!,
  });

  expect(result.settled).toBe(true);
  // The last change is seen at 300ms, and the 200ms quiet window clears at 500ms: the wait is
  // measured from the last CHANGE, not from the last poll that happened to repeat.
  expect(result.waitedMs).toBe(500);
});

test("does not mistake a pane that has not started yet for one that has finished", async () => {
  // The bug this exists to prevent, measured on a real fork: the CLI writes nothing for its first
  // second, so a wait that accepts quiet immediately returns before the startup it is waiting for
  // has begun, and the viewer receives the whole dump live anyway.
  const samples = [
    "0 0 0", "0 0 0", "0 0 0", "0 0 0", "0 0 0", "0 0 0",  // 600ms of silence while it loads
    "40 3 1", "80 6 2",                                     // then it writes
    "80 6 2", "80 6 2", "80 6 2", "80 6 2",                 // then it is done
  ];
  let index = 0;
  let clock = 0;
  const result = await waitForPaneToSettle("pane", {
    quietMs: 200,
    pollMs: 100,
    startupMs: 3_000,
    timeoutMs: 5_000,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    sample: async () => samples[Math.min(index++, samples.length - 1)]!,
  });

  expect(result.settled).toBe(true);
  // Past the silence, past the writing, and only then the quiet window -- not 200ms.
  expect(result.waitedMs).toBe(900);
});

test("stops waiting on a pane that never writes at all", async () => {
  let clock = 0;
  const result = await waitForPaneToSettle("pane", {
    quietMs: 200,
    pollMs: 100,
    startupMs: 500,
    timeoutMs: 10_000,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    sample: async () => "0 0 0",
  });

  // Nothing was ever written, so there is nothing for a capture to collapse and no reason to sit
  // out the full timeout.
  expect(result.settled).toBe(true);
  expect(result.waitedMs).toBe(500);
});

test("gives up on a pane that never stops writing rather than never attaching", async () => {
  let clock = 0;
  let index = 0;
  const result = await waitForPaneToSettle("pane", {
    quietMs: 200,
    pollMs: 100,
    timeoutMs: 1_000,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    sample: async () => `${index++} 0 0`,
  });

  // Watching a busy program late is right; refusing to watch it is not.
  expect(result.settled).toBe(false);
  expect(result.waitedMs).toBeGreaterThanOrEqual(1_000);
});

test("stops waiting when the pane cannot be described at all", async () => {
  let clock = 0;
  const result = await waitForPaneToSettle("pane", {
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    sample: async () => { throw new Error("no such pane"); },
  });

  // The attach that follows reports the real failure; waiting on it would only delay that.
  expect(result.settled).toBe(false);
  expect(result.waitedMs).toBe(0);
});

// The session identity stamp: what makes a pane findable after its name changes.

test("the stamp target carries no '=', because set-option refuses one", () => {
  // Measured 2026-09-08: `set-option -t =name` answers `no such session: =name` for a session
  // that is right there, and fails with the option silently unset -- so a later lookup finds
  // nothing and concludes the pane is gone. `has-session` is the opposite and requires it.
  expect(setSessionIdentityArgs("canvas-session", "b18b005e")).toEqual([
    "set-option", "-t", "canvas-session", "@agentdesk-session", "b18b005e",
  ]);
  expect(hasSessionArgs("canvas-session")).toEqual(["has-session", "-t", "=canvas-session"]);
});

test("a rename targets exactly, so a prefix cannot rename somebody else's session", () => {
  // tmux resolves a bare -t by exact match, then PREFIX: `-t canvas` would find `canvas-session`.
  expect(renameSessionArgs("canvas", "terminal-tiles")).toEqual([
    "rename-session", "-t", "=canvas", "terminal-tiles",
  ]);
});

test("sessions without a stamp are skipped rather than failing the query", () => {
  // Every session tmux holds that this sidecar did not start prints an empty option. That is the
  // common case on this machine, not an error.
  const found = parseTmuxSessionIdentities([
    "someones-shell|",
    "canvas-session|b18b005e",
    "|orphan-with-no-name",
  ].join("\n"));
  expect(found.get("b18b005e")).toBe("canvas-session");
  expect(found.size).toBe(1);
});

test("two panes claiming one session keep the reader on the first", () => {
  // A bug elsewhere, but picking the later one would move a viewer off the pane it was reading.
  const found = parseTmuxSessionIdentities("first|shared\nsecond|shared");
  expect(found.get("shared")).toBe("first");
});

test("a line with no separator is not a session", () => {
  // Format drift rather than data. Reading it as a bare name would map a session id of "" onto
  // it, and the first lookup for an unstamped session would then answer with that pane.
  const found = parseTmuxSessionIdentities("no-separator-here\ncanvas-session|b18b005e");
  expect(found.size).toBe(1);
  expect(found.get("b18b005e")).toBe("canvas-session");
});

test("the id is trimmed, so a trailing newline is not part of it", () => {
  const found = parseTmuxSessionIdentities("canvas-session|b18b005e  \n");
  expect(found.get("b18b005e")).toBe("canvas-session");
});

// The two strings below are verbatim tmux 3.6b, captured on one machine a second apart by killing
// a server and then deleting its socket. They are the point of these tests: the guard they feed
// reads prose, so the prose is what has to be pinned, and a tmux that changes either wording
// breaks the terminal in a way no other test here would notice.
test("reads both of tmux's ways of saying there is no server", () => {
  expect(noServerRunning("no server running on /private/tmp/tmux-501/default\n")).toBe(true);
  expect(noServerRunning(
    "error connecting to /private/tmp/tmux-501/default (No such file or directory)\n",
  )).toBe(true);
});

test("does not read a missing session as a missing server", () => {
  // Different answers hang off these: no server means the machine is empty and a terminal may
  // start one, a missing session means the server is fine and that pane is gone.
  expect(noServerRunning("can't find session: nope\n")).toBe(false);
  expect(noSuchSession("can't find session: nope\n")).toBe(true);
  expect(noSuchSession("no server running on /private/tmp/tmux-501/default\n")).toBe(false);
});

test("keeps a real tmux failure a failure", () => {
  expect(noServerRunning("lost server")).toBe(false);
  expect(noServerRunning("/private/tmp/tmux-501: No such file or directory")).toBe(false);
  expect(noSuchSession("lost server")).toBe(false);
});
