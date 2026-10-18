// What a pane is showing, and what it has shown: the scrollback, the screen, the cursor,
// and whether it has stopped writing yet.
//
// Every comment below is a measurement about how tmux numbers rows and how a terminal
// replays them. Read them before changing an argument list.

import { TmuxUnavailable, demand, tmux } from "@/terminal/tmux/tmuxCommand";

/**
 * What tmux is asked for: the scrollback, and deliberately NOT the screen.
 *
 * tmux numbers the visible screen from 0 and the scrollback with negatives, so `-E -1` ends the
 * range one line above the top of the screen. The screen is excluded because the live stream is
 * about to paint it: a viewer that also imports it as text writes a second, frozen copy, and
 * tmux's redraw then addresses screen rows absolutely into a window that overlaps that copy.
 * Measured on a pane holding 1066 scrollback lines: `-S -50000` returned 1089, the extra 23 being
 * the screen, and the redraw landing one row out left half-overwritten lines through the history.
 *
 * `-e` keeps the colour. `-J` is deliberately absent, since joining wrapped lines would reflow
 * output that was laid out for a different width.
 */
export function captureHistoryArgs(session: string, lines: number): string[] {
  return ["capture-pane", "-p", "-e", "-S", `-${lines}`, "-E", "-1", "-t", session];
}

/** The visible screen on its own, which is the part the scrollback range deliberately omits. */
export function captureScreenArgs(session: string): string[] {
  return ["capture-pane", "-p", "-e", "-t", session];
}

/**
 * How far above the screen a question dialog may have started.
 *
 * Measured 2026-09-15 on an 80x24 pane: one question with four options and a fifty-word
 * description on each began 40 rows above the top of the screen. Sixty leaves room for the
 * tallest shape the tool allows and still costs one tmux call.
 */
export const QUESTION_HISTORY_LINES = 60;

/**
 * The scrollback AND the screen, for reading a dialog that does not fit in its pane.
 *
 * The only capture here that asks for both, and it exists because a question dialog is not
 * bounded by the pane: Claude draws it in full and the terminal scrolls, so a tall one leaves its
 * opening rule, tab row and question text above the screen. The reader needs all three -- it finds
 * a dialog by its footer and then bounds it by the two rules above -- so read from the screen
 * alone it saw no dialog at all, and the driver reported the question as no longer open.
 *
 * `-E -1` is deliberately absent, which is the whole difference from `captureHistoryArgs`: that
 * one excludes the screen because a viewer is about to paint it, and this one is not painting
 * anything.
 *
 * The cursor that comes back is still the SCREEN's, so it does not index into what this returns.
 * Nothing reading a question uses it -- the dialog marks its own cursor row with `❯` -- and this
 * is the reason not to reach for it here.
 */
export function captureQuestionViewArgs(session: string, lines: number): string[] {
  return [
    "display-message",
    "-p",
    "-t",
    session,
    "#{cursor_y} #{cursor_x}",
    ";",
    "capture-pane",
    "-p",
    "-e",
    "-S",
    `-${lines}`,
    "-t",
    session,
  ];
}

/**
 * How tall that screen is, where the cursor sits in it, and which screen it IS.
 *
 * The height says how many rows the viewer has to open. The cursor says where to leave it, which
 * matters because the program on the other end goes on drawing RELATIVE to it: Claude Code's
 * renderer redraws by moving from where it believes the cursor is. Measured on a live pane: a
 * viewer that ended its import at the end of the captured text left the cursor several rows below
 * the composer, and every subsequent keystroke was echoed onto the status divider instead of into
 * the box -- correct bytes, correct terminal, wrong origin.
 *
 * `alternate_on` is the third because a capture carries text and a cursor and NOT the terminal
 * modes in force, and the viewer has no other way to learn them: `pipe-pane` starts at now, so the
 * `ESC[?1049h` that put a fullscreen program on the alternate screen was written once at its
 * startup and is never sent again. A viewer joining afterwards therefore paints an alternate
 * screen into its normal buffer and believes it is looking at ordinary output. See
 * `terminalHistoryPayload`.
 */
export function paneGeometryArgs(session: string): string[] {
  return ["display-message", "-p", "-t", session, "#{pane_height} #{cursor_y} #{cursor_x} #{alternate_on}"];
}

/** What tmux says about a pane right now: the screen it is showing, and where its cursor sits. */
export interface TmuxPaneView {
  screen: string;
  /** The cursor's own row and column in the pane, counted from the top left of the screen. */
  cursor: { row: number; column: number };
}

/**
 * The screen and the cursor, asked for in ONE tmux invocation.
 *
 * Two commands separated by `;`, which tmux runs on one client connection and answers in order:
 * the cursor on the first line, the screen after it. Two spawns would be the obvious spelling and
 * would cost a second process on every read, and the composer's watcher reads on every burst of
 * pane output -- up to about seven a second per session somebody is typing in.
 *
 * The cursor is not decoration beside the text; it carries what the text CANNOT. tmux pads every
 * captured row to the pane width, so a composer holding `abc ` and one holding `abc` come back as
 * the same string and a trailing space is unrecoverable from the capture alone. Measured
 * 2026-09-08: `abc` reported column 5, `abc ` reported 6, and `abc   ` reported 8, against a box
 * that starts at column 2. So the column is the true length of the row the cursor is on, and the
 * row says which line of a wrapped box the reader is actually on.
 */
export function capturePaneViewArgs(session: string): string[] {
  return ["display-message", "-p", "-t", session, "#{cursor_y} #{cursor_x}", ";", ...captureScreenArgs(session)];
}

/**
 * What the pane is showing and where its cursor is, colour and all.
 *
 * The colour is not incidental to a reader, which is why this shares `captureScreenArgs` with the
 * painting path instead of asking for plain text. Claude draws its composer placeholder in the
 * same box as a real prompt and the only thing separating them is that the placeholder is DIM --
 * measured as `\u001b[2m<no suggestion>\u001b[0m`, where typed text carries no such run. Strip the
 * escapes at the source and the two become one string, and the panel mirrors a hint back into
 * somebody's session as if they had typed it.
 */
export async function captureTmuxPaneView(session: string): Promise<TmuxPaneView> {
  return readPaneView(capturePaneViewArgs(session));
}

/** The same reading, over a range that starts above the screen. See `captureQuestionViewArgs`. */
export async function captureTmuxQuestionView(session: string): Promise<TmuxPaneView> {
  return readPaneView(captureQuestionViewArgs(session, QUESTION_HISTORY_LINES));
}

async function readPaneView(args: string[]): Promise<TmuxPaneView> {
  const result = await tmux(args);
  demand("pane view", result);
  const split = result.out.indexOf("\n");
  const where = (split === -1 ? result.out : result.out.slice(0, split)).trim().split(/\s+/);
  const row = Number.parseInt(where[0] ?? "", 10);
  const column = Number.parseInt(where[1] ?? "", 10);
  // Loud rather than assumed. A cursor this cannot read is not a cursor at the end of the box, and
  // treating it as one is exactly the guess that corrupts a composer.
  if (!Number.isInteger(row) || !Number.isInteger(column) || row < 0 || column < 0) {
    throw new TmuxUnavailable(`tmux reported an unusable cursor: ${result.out.slice(0, 80)}`);
  }
  return { screen: split === -1 ? "" : result.out.slice(split + 1), cursor: { row, column } };
}

/**
 * Scrollback, then a screen's worth of blank rows, then the screen painted into them.
 *
 * The blank rows are the whole point, and they are not padding. A terminal's active screen is
 * always the last `rows` lines of its buffer, and tmux addresses that screen absolutely: row 1 is
 * row 1 whatever is under it. Write the scrollback and stop, and the screen window still straddles
 * the last rows of that scrollback, so tmux's next repaint overwrites part of each of those lines
 * and leaves the rest -- history that reads as corruption rather than as a positioning bug. Opening
 * `rows - 1` lines (the scrollback's own trailing newline is the first) puts the window entirely on
 * blank rows below the history, and `ESC[H` homes into it before the screen text fills it exactly.
 *
 * It ends by putting the cursor where the pane's actually is, rather than wherever the screen text
 * happened to run out. See `paneGeometryArgs`.
 *
 * Composed here rather than in the viewer because the row count that has to match is the pane's,
 * and the pane is what this module can see.
 */
export function terminalHistoryPayload({
  scrollback,
  screen,
  rows,
  cursor,
  alternateScreen = false,
}: {
  scrollback: string;
  screen: string;
  rows: number;
  /** The pane's cursor, zero-based as tmux reports it. */
  cursor: { row: number; column: number };
  /** Whether the pane is on the alternate screen, which changes what there is to hand over. */
  alternateScreen?: boolean;
}): string {
  // CUP is one-based, and addresses the screen -- which the opening rows below put exactly where
  // the pane's screen is.
  const home = `\u001b[${cursor.row + 1};${cursor.column + 1}H`;
  // Full-bleed rather than verbatim: the capture trims every row's trailing cells, and a
  // trimmed row written straight paints its card's colours only behind its text -- see
  // `fullBleedCapture` for the measurement that bought this.
  const painted = fullBleedCapture(screen.replace(/\n$/, ""));
  // An alternate screen has no history to sit above it, by definition: tmux keeps no scrollback for
  // one, and a fullscreen program redraws rather than scrolls. So the viewer is told to switch
  // buffers and handed the screen, and the two paragraphs of positioning below do not apply --
  // there is nothing under this screen for it to straddle.
  //
  // The switch is sent for the viewer's own sake rather than for the picture, which would look the
  // same either way. It puts xterm in the state the pane is in, so `buffer.active.type` answers
  // truthfully, the imported screen stays out of the scrollback the reader scrolls, and the wheel
  // can be forwarded to the program instead of moving an empty buffer. See `mouseReporting`.
  if (alternateScreen) return `\u001b[?1049h\u001b[H${painted}${home}`;
  const history = fullBleedCapture(scrollback);
  const opening = "\r\n".repeat(Math.max(0, rows - 1));
  return `${history}${opening}\u001b[H${painted}${home}`;
}

/** Everything the viewer needs to open with: the pane's scrollback and its current screen. */
export async function captureTmuxHistory(session: string, lines: number): Promise<string> {
  const [history, screen, geometry] = await Promise.all([
    tmux(captureHistoryArgs(session, lines)),
    tmux(captureScreenArgs(session)),
    tmux(paneGeometryArgs(session)),
  ]);
  // Named individually because the three are different commands: a reader told "capture-pane
  // failed" when it was `display-message` that failed looks for the bug in the wrong place.
  demand("scrollback", history);
  demand("screen", screen);
  demand("pane geometry", geometry);
  const fields = geometry.out.trim().split(/\s+/);
  const rows = Number.parseInt(fields[0] ?? "", 10);
  if (!Number.isInteger(rows) || rows < 1) {
    throw new TmuxUnavailable(`tmux reported an unusable pane height: ${geometry.out.trim()}`);
  }
  // A tmux old enough not to report a cursor still gets a correct screen; it just resumes from the
  // top of it, which is the behaviour this replaces rather than a new failure.
  const coordinate = (field: string | undefined): number => {
    const value = Number.parseInt(field ?? "", 10);
    return Number.isInteger(value) && value >= 0 ? value : 0;
  };
  return terminalHistoryPayload({
    scrollback: history.out,
    screen: screen.out,
    rows,
    cursor: { row: coordinate(fields[1]), column: coordinate(fields[2]) },
    alternateScreen: fields[3] === "1",
  });
}

/**
 * Line feeds become carriage-return line feeds, because the destination is a terminal.
 *
 * `capture-pane` writes text, one line per line, separated by LF. A terminal reading a bare LF
 * moves down a row and stays in the column it was in, so every line after the first starts where
 * the previous one ended: the history arrives as a staircase of fragments, each indented by the
 * length of the line above it. Seen exactly that way before this existed.
 */
export function historyForTerminal(captured: string): string {
  return captured.replace(/\r?\n/g, "\r\n");
}

/**
 * One captured row's leading colours, for filling a row the capture emptied.
 *
 * Only SGR colour runs count, and only at the very start: what a row's first cell carries is
 * what its whole width was painted with when the row is full-bleed, which is exactly the row
 * a trim empties. Anything else at the start -- plain text, an OSC hyperlink -- says the row
 * begins in the default colours, which is itself an answer.
 */
const LEADING_SGR_RUN = /^((?:\u001b\[[0-9;:]*m)+)/;

function leadingSgrRun(line: string): string {
  return line.match(LEADING_SGR_RUN)?.[1] ?? "";
}

/**
 * A capture rewritten so every row paints its whole width, because `capture-pane` trims.
 *
 * Measured on a live opencode: every captured row shorter than the pane ends where its text
 * ends, and rows the program painted edge to edge with background spaces come back as zero
 * bytes -- not even their colours survive. Written straight into a terminal, the trimmed
 * cells keep whatever the theme paints as default, so a grey card reads as grey text on
 * black bands with a black fringe down its right edge. A resize hides it, not because the
 * checkpoint paints different bytes, but because the SIGWINCH makes the program repaint
 * live at full bleed behind it -- which is why a refresh, with no resize and no repaint,
 * is where it shows.
 *
 * So each row is made self-contained and full-bleed: a reset first, so one row's trailing
 * colours cannot smear into the next row's default cells, and an erase-to-end behind its
 * text, which fills exactly to the margin in the row's own trailing colours with no width
 * to count and nothing that can wrap. A row the trim emptied is filled from the next row
 * that still has colours -- the card continuing below it -- and left bare where nothing
 * below has any, which is the bottom of the screen staying the theme's own.
 */
export function fullBleedCapture(captured: string): string {
  const lines = captured.split("\n");
  return lines
    .map((line, index) => {
      // A row with anything in it, colours included: a row the trim reduced to only its
      // colours is still a row, and its own run still says what its width was painted.
      if (line.length > 0) return `\u001b[0m${line}\u001b[K`;
      for (let below = index + 1; below < lines.length; below += 1) {
        const candidate = lines[below]!;
        if (candidate.length === 0) continue;
        const run = leadingSgrRun(candidate);
        // A next row starting in the default colours says the gap is default too, and bare
        // inherits whatever the row above left -- which the reset above just made explicit.
        if (run === "") return "";
        return `${run}\u001b[K`;
      }
      return "";
    })
    .join("\r\n");
}

/**
 * What a pane looks like right now, cheaply, for deciding whether it has stopped writing.
 *
 * `history_size` catches output that scrolled away and the cursor catches a redraw that stayed on
 * one screen, which a full-screen program does constantly. Either alone misses half of what
 * "still working" looks like.
 */
export function paneActivityArgs(session: string): string[] {
  return ["display-message", "-p", "-t", session, "#{history_size} #{cursor_y} #{cursor_x} #{pane_dead}"];
}

export async function paneActivity(session: string): Promise<string> {
  const { out, code } = await tmux(paneActivityArgs(session));
  if (code !== 0) throw new TmuxUnavailable(`tmux display-message exited ${code}`);
  return out.trim();
}

/**
 * Waits for a pane this process just created to stop writing, or gives up.
 *
 * The reason is what a tmux client gets for free and this path does not. `pipe-pane` starts at
 * NOW, so a viewer that attaches to a pane at the instant it is born receives the program's entire
 * startup as live output -- every escape and every intermediate repaint -- and has to emulate all
 * of it. A viewer that arrives later gets the same thing already collapsed by `capture-pane`, which
 * is exactly what tmux hands its own clients: the settled screen, not the working.
 *
 * So a freshly created pane waits here first. Measured on a forked CLI: it wrote ~148KB in the
 * first second and a half and then went quiet, and attaching after that turned 24 live output
 * messages into one capture and nothing on the wire.
 *
 * Bounded, and the bound is not an error: a program that never stops writing is a legitimate thing
 * to watch, and it should be watched late rather than not at all.
 */
export async function waitForPaneToSettle(
  session: string,
  options: {
    quietMs?: number;
    timeoutMs?: number;
    pollMs?: number;
    startupMs?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    sample?: (session: string) => Promise<string>;
  } = {},
): Promise<{ settled: boolean; waitedMs: number }> {
  const quietMs = options.quietMs ?? 400;
  const timeoutMs = options.timeoutMs ?? 6_000;
  const pollMs = options.pollMs ?? 100;
  // How long to give a pane that has not written anything YET.
  //
  // Measured, and the reason a first attempt at this did nothing: a pane is silent for its first
  // second or so while the program loads, so "no change for 400ms" is true immediately and the
  // wait returned before the startup it exists to wait for had begun. Quiet only counts once the
  // pane has shown it is alive.
  const startupMs = options.startupMs ?? 3_000;
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const sample = options.sample ?? paneActivity;

  const start = now();
  let baseline: string | null = null;
  let lastChange = start;
  let stirred = false;
  while (now() - start < timeoutMs) {
    let current: string;
    try {
      current = await sample(session);
    } catch {
      // A pane that cannot be described is not a pane worth waiting for; let the attach report it.
      return { settled: false, waitedMs: now() - start };
    }
    if (baseline === null) {
      baseline = current;
    } else if (current !== baseline) {
      baseline = current;
      lastChange = now();
      stirred = true;
    } else if (stirred && now() - lastChange >= quietMs) {
      return { settled: true, waitedMs: now() - start };
    } else if (!stirred && now() - start >= startupMs) {
      // Never wrote a byte. Nothing to collapse, so nothing to wait for.
      return { settled: true, waitedMs: now() - start };
    }
    await sleep(pollMs);
  }
  return { settled: false, waitedMs: now() - start };
}
