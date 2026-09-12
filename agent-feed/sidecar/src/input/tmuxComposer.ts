// Reading and driving the composer of a Claude CLI that is running inside a tmux pane.
//
// The screen is the only interface a TUI has. There is no accessibility tree to read and no socket
// that answers "what is in your prompt box", so this reads `capture-pane` and writes `send-keys`,
// and every rule below is a measured property of Claude Code's own renderer (v2.1.263, on a 60
// column pane) rather than an assumption about TUIs in general:
//
//   The box is a rule line, a row beginning `❯ `, zero or more rows indented by two, and a rule.
//   An empty composer still draws it, as `❯ ` alone; a pane mid-redraw draws none of it at all.
//
//   Claude WORD-WRAPS the box itself, emitting a real row per visual line rather than letting the
//   terminal wrap. `capture-pane -J` therefore does not rejoin them -- it joins only terminal-
//   wrapped lines, which was measured on a `cat` pane and does not apply here -- and the space the
//   wrap consumed survives in neither row. So a multi-row composer cannot be reconstructed exactly.
//
//   Ctrl+U kills one VISUAL row, not the whole prompt: a four-row composer needs four of them.
//   That is the one exact lever over a composer whose text cannot be read exactly.
//
//   An EMPTY box is not always empty-looking. Claude draws a suggestion in it, and the only thing
//   separating that from typed words is that it is FAINT. So the screen is read with its colour
//   on, which is the one place an escape sequence here is content rather than noise. The hint
//   travels beside the text rather than as part of it, and Tab is what fills it in -- measured:
//   after a Tab the same row comes back with no faint run at all.
//
// What falls out of those three is the shape of `keystrokesFor`. An exactly-known composer is
// edited incrementally, which is what makes typing feel like typing. An inexactly-known one is
// only ever treated as a HYPOTHESIS: if the guessed text is the start of what is wanted the rest
// is appended, and if the guess was wrong the box is cleared by row count and retyped. A wrong
// guess therefore costs a retype and can never corrupt the pane, which is the property worth
// having -- the pane belongs to whoever is sitting in front of it.

import type { TmuxComposerState } from "@agentdesk/agent-feed-wire";
import { liveTmuxSession } from "../terminal/agentTerminalService.ts";
import { captureTmuxScreen, hexSend, TmuxUnavailable } from "../terminal/tmuxSessions.ts";

/** The character Claude draws at the head of its prompt box. */
const PROMPT = "❯";
/**
 * What separates the marker from the text, and it is not an ordinary space.
 *
 * Claude writes a NO-BREAK space there, measured on a live pane (`\u276f\u00a0make the...`). An
 * ordinary-space strip therefore left one character of padding at the head of every reading, which
 * the panel would then have pushed back into the box as if the reader had typed it.
 */
const GAP = /^[ \u00a0]/;
/** Continuation rows are indented by two ORDINARY spaces, to sit under the text. */
const INDENT = "  ";
/**
 * How much box drawing makes a line a rule.
 *
 * A run rather than a whole-line test, because a rule carries a label: the pane's own title is
 * drawn into the top one. Eight is far more than prose contains and far less than any rule.
 */
const RULE = /─{8}/;
/** Every colour and style run, which the screen carries because one of them is load-bearing. */
const SGR = /\u001b\[[0-9;]*m/g;
/** One such run at the head of what is left, with its parameters, for asking whether it is dim. */
const SGR_HEAD = /^\u001b\[([0-9;]*)m/;
/**
 * The SGR parameter for faint text, which is how Claude draws a composer PLACEHOLDER.
 *
 * Measured on a live pane after a turn: `\u001b[39m❯\u00a0\u001b[2m<no suggestion>\u001b[0m`. With the
 * escapes stripped that is indistinguishable from somebody having typed those words, and the
 * mirror would have filled a reader's field with it and then typed it back into the session. It is
 * the only thing on the screen that says otherwise.
 */
const FAINT = "2";

/** Kill to the start of the visual row. One per row is what empties the box. */
const KILL_ROW = "\u0015";
const BACKSPACE = "\u007f";
const CARRIAGE_RETURN = "\r";
/** What accepts Claude's suggestion. Measured: the row comes back with no faint run at all. */
const TAB = "\t";
const PASTE_START = "\u001b[200~";
const PASTE_END = "\u001b[201~";

/**
 * How much text the panel may push into somebody's pane.
 *
 * Smaller than the terminal input route's own 64 KiB ceiling, deliberately: that one bounds a
 * turn sent once, and this one bounds text that is retyped every time a guess misses.
 */
export const MAXIMUM_COMPOSER_BYTES = 16 * 1024;

/** What the box is showing: what is in it, and what Claude is offering to put there. */
export interface ComposerBox {
  /**
   * The composer's rows as the screen shows them.
   *
   * Rows rather than text, because the ROW COUNT is exact where the text is not, and it is the
   * row count that clearing depends on.
   */
  rows: string[];
  /** Claude's suggestion, when the box is holding one instead of somebody's text. */
  hint: string | null;
}

/** What the composer box holds, or null when the screen shows no box at all. */
export function composerBox(screen: string): ComposerBox | null {
  const raw = screen.split("\n");
  const lines = raw.map(plainText);
  const head = lastPromptRow(lines);
  if (head === null) return null;
  // A suggestion fills the box and IS the box, so the composer reads as empty and the suggestion
  // travels separately. Asked of the RAW row, because the answer is in the escapes.
  if (isPlaceholder(raw[head]!)) {
    return { rows: [""], hint: lines[head]!.slice(PROMPT.length).replace(GAP, "") || null };
  }
  const rows = [lines[head]!.slice(PROMPT.length).replace(GAP, "")];
  for (let index = head + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (RULE.test(line)) break;
    // Anything not indented into the box has left it. The status line under the bottom rule is
    // indented too, so the rule is what usually stops this; a redraw that dropped the rule would
    // otherwise swallow the whole footer into the composer.
    if (!line.startsWith(INDENT)) break;
    rows.push(line.slice(INDENT.length));
  }
  return { rows, hint: null };
}

/** A screen line with its colour taken off and its padding trimmed, which is what parses. */
function plainText(line: string): string {
  return line.replace(SGR, "").replace(/\s+$/, "");
}

/**
 * Whether this prompt row is Claude's own hint rather than somebody's text.
 *
 * True when the first thing after the marker opens a faint run. Nothing a reader types arrives
 * dim, and the hint is dim from its first character, so the question is only ever asked of the
 * one position where the two could be confused.
 */
function isPlaceholder(rawPromptRow: string): boolean {
  let rest = rawPromptRow;
  // Style set before the marker is the box's own, not the text's; step over it.
  for (let head = SGR_HEAD.exec(rest); head !== null; head = SGR_HEAD.exec(rest)) {
    rest = rest.slice(head[0].length);
  }
  if (!rest.startsWith(PROMPT)) return false;
  rest = rest.slice(PROMPT.length).replace(GAP, "");
  const head = SGR_HEAD.exec(rest);
  return head !== null && head[1]!.split(";").includes(FAINT);
}

/**
 * The prompt row of the LAST composer box on the screen.
 *
 * Anchored on the rule above it rather than on the marker alone. Claude echoes each of the user's
 * own turns into the transcript with the same marker, so a screen holding two turns has three
 * candidate rows and only the last one is a box that can be typed into.
 */
function lastPromptRow(lines: string[]): number | null {
  for (let index = lines.length - 1; index >= 1; index -= 1) {
    if (!lines[index]!.startsWith(PROMPT)) continue;
    if (!RULE.test(lines[index - 1]!)) continue;
    return index;
  }
  return null;
}

/**
 * The text those rows probably hold.
 *
 * Joined with a space because the wrap Claude performs is a WORD wrap, and the space it broke on
 * survives in neither row. Exact for a single row and a hypothesis for more than one, which is
 * why `wrapped` travels beside it all the way to the panel.
 */
export function composerText(rows: readonly string[]): string {
  return rows.join(" ");
}

/**
 * The bytes that turn a composer holding `rows` into one holding `desired`.
 *
 * Three shapes, in the order they are worth trying:
 *
 *   Nothing, when the box already reads that way. The commonest outcome of all, because the panel
 *   pushes after a debounce and the previous push usually already landed it.
 *
 *   An append, when what is there is the start of what is wanted. This is the typing case, and it
 *   is what makes a keystroke in the panel cost a keystroke in the pane.
 *
 *   A clear and a retype, for everything else: an edit in the middle of the line, a wrapped
 *   composer whose reconstruction was wrong, a pane somebody else has been typing into. Exact
 *   whatever the box holds, because the row count is exact even when the text is not.
 *
 * Inserted text is always a bracketed paste. Claude reads a paste literally, where a bare `/` or
 * `@` at the head of an empty composer opens a menu that then eats what follows it.
 */
export function keystrokesFor(rows: readonly string[], desired: string): string {
  const current = composerText(rows);
  if (current === desired) return "";
  if (current.length > 0 && desired.startsWith(current)) {
    return paste(desired.slice(current.length));
  }
  // A single row is known exactly, so a correction rubs out only what diverged -- which keeps a
  // backspace in the panel costing a backspace in the pane rather than a whole retype.
  if (rows.length === 1) {
    const shared = commonPrefix(current, desired);
    const removed = [...current.slice(shared.length)].length;
    return BACKSPACE.repeat(removed) + paste(desired.slice(shared.length));
  }
  return KILL_ROW.repeat(rows.length) + paste(desired);
}

/** Nothing to insert sends nothing: an empty bracketed paste still makes Claude redraw the box. */
function paste(text: string): string {
  if (text.length === 0) return "";
  // A composer's own text can contain an escape, and it must arrive as one visible character
  // rather than as the start of a sequence the pane will act on. Same guard the terminal prompt
  // route makes, for the same reason.
  return `${PASTE_START}${text.replaceAll("\u001b", "\u241b")}${PASTE_END}`;
}

/** By code point, so an emoji costs one backspace rather than two. */
function commonPrefix(left: string, right: string): string {
  const leftPoints = [...left];
  const rightPoints = [...right];
  const shared: string[] = [];
  for (let index = 0; index < leftPoints.length && index < rightPoints.length; index += 1) {
    if (leftPoints[index] !== rightPoints[index]) break;
    shared.push(leftPoints[index]!);
  }
  return shared.join("");
}

/** Everything the live functions need from tmux, injected so the suite needs no tmux server. */
export interface TmuxComposerRuntime {
  pane: (sessionId: string) => Promise<string | null>;
  screen: (pane: string) => Promise<string>;
  send: (pane: string, bytes: Uint8Array) => Promise<void>;
}

/** What watching additionally needs: a way to be told the pane wrote something. */
export interface TmuxComposerWatchRuntime extends TmuxComposerRuntime {
  /**
   * Asks to be told when the pane writes, until the returned function is called.
   *
   * Not implemented in this module, and that is structural rather than shy: a pane has exactly
   * one pipe and the terminal service owns it, so a second one set here would not add a listener,
   * it would silently replace that service's. `server.ts` wires this to the service's own.
   */
  watch: (pane: string, onOutput: () => void) => Promise<() => void>;
}

/**
 * The shortest gap between two screen reads, and the delay after output before the first.
 *
 * A pane writes in bursts -- one keystroke redraws the box, one turn redraws everything -- so
 * reading per burst would read many times for one change. Trailing rather than leading, so the
 * read sees the burst finished rather than halfway through: a capture taken mid-redraw is the
 * `no-composer` case, which would show as the mirror blinking out and back on every keystroke.
 *
 * At 150ms a pane being typed into costs at most seven reads a second and an idle one costs
 * NONE, which is the whole point of this being driven by output instead of by a clock.
 */
const COALESCE_MS = 150;

const LIVE: TmuxComposerRuntime = {
  pane: (sessionId) => liveTmuxSession("claude", sessionId),
  screen: captureTmuxScreen,
  send: hexSend,
};

/** The live runtime, given the pane signal only the terminal service can supply. */
export function liveTmuxComposerRuntime(
  watch: TmuxComposerWatchRuntime["watch"],
): TmuxComposerWatchRuntime {
  return { ...LIVE, watch };
}

/** Where a watcher's reports go, and how it says there will be no more of them. */
export interface TmuxComposerListener {
  onState: (state: TmuxComposerState) => void;
  /**
   * There is nothing to watch, so nothing further will be said.
   *
   * Separate from a reason on the state because it is about the WATCH, not the composer: it means
   * ask again later if you still care, and the caller decides how much later. An `EventSource`
   * decides by reconnecting, which is why nothing here holds a retry timer.
   */
  onEnd: () => void;
}

/**
 * Reports what the session's composer holds, and again whenever it CHANGES, until stopped.
 *
 * Driven by the pane's own output rather than by a timer. That is the difference between a mirror
 * that costs a `capture-pane` every second forever and one that costs nothing at all while
 * nobody is typing -- which is most of the time, and exactly the state a composer sits in.
 *
 * Only differences are reported. A redraw that leaves the box alone -- which is nearly every
 * redraw, since a working session is writing above its composer, not into it -- is read and
 * dropped here rather than sent to every panel watching.
 *
 * A session with no pane ENDS rather than waiting: there is nothing to hang a pipe on, and a
 * session gains a pane later often enough to matter -- pressing the band's own terminal button
 * resumes one. Ending hands the retry to whoever asked, where a stream that stayed open would
 * have to grow a timer to notice, which is the thing this replaced.
 *
 * A pane that DIES is not noticed here, and deliberately: the pipe simply goes quiet. It is
 * noticed at the next push, which re-resolves the pane and answers `no-pane` -- the same place
 * `useCliInput` corrects a session that died under the composer, and the moment a reader is
 * about to care.
 */
export function observeTmuxComposer(
  sessionId: string,
  listener: TmuxComposerListener,
  runtime: TmuxComposerWatchRuntime,
): () => void {
  const { onState } = listener;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let reading = false;
  /** What the last report said, so an unchanged screen is not reported again. */
  let reported: string | null = null;
  let unwatch: (() => void) | null = null;

  const end = (): void => {
    if (stopped) return;
    stopped = true;
    listener.onEnd();
  };

  const report = (state: TmuxComposerState): void => {
    if (stopped) return;
    const signature = JSON.stringify(state);
    if (signature === reported) return;
    reported = signature;
    onState(state);
  };

  const readNow = async (): Promise<void> => {
    if (stopped || reading) return;
    reading = true;
    try {
      report(await readTmuxComposer(sessionId, runtime));
    } catch {
      // A read that threw is not evidence about the composer, and the next output brings another.
    } finally {
      reading = false;
    }
  };

  const schedule = (): void => {
    if (stopped || timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      void readNow();
    }, COALESCE_MS);
  };

  void (async () => {
    let pane: string | null;
    try {
      pane = await runtime.pane(sessionId);
    } catch {
      pane = null;
    }
    if (stopped) return;
    if (!pane) {
      report(unavailable("no-pane"));
      end();
      return;
    }
    try {
      const stop = await runtime.watch(pane, schedule);
      if (stopped) {
        stop();
        return;
      }
      unwatch = stop;
    } catch {
      report(unavailable("tmux-unavailable"));
      end();
      return;
    }
    // The first reading is not waited for: a pane that is sitting idle writes nothing, so a
    // watcher that only spoke on output would say nothing at all until somebody typed.
    await readNow();
  })();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    unwatch?.();
  };
}

/** What the session's composer is showing, or why it cannot be seen. */
export async function readTmuxComposer(
  sessionId: string,
  runtime: TmuxComposerRuntime = LIVE,
): Promise<TmuxComposerState> {
  const reading = await observe(sessionId, runtime);
  if ("reason" in reading) return unavailable(reading.reason);
  return {
    text: composerText(reading.rows),
    hint: reading.hint,
    reason: null,
    wrapped: reading.rows.length > 1,
  };
}

/**
 * Makes the session's composer read `desired`, and reports what it reads afterwards.
 *
 * The screen is read HERE rather than taken from the caller, and that is the whole reason this
 * lives in the sidecar: the person at that keyboard is typing too, so an observation that made a
 * round trip through a browser is old enough to compute the wrong keystrokes from.
 *
 * What comes back is what was asked for, not a fresh read. Reading again immediately afterwards
 * would be a guess at how long Claude takes to redraw, and a read that lands mid-redraw reports no
 * composer at all -- which the panel would show as the sync having failed.
 */
export async function syncTmuxComposer(
  sessionId: string,
  desired: string,
  runtime: TmuxComposerRuntime = LIVE,
): Promise<TmuxComposerState> {
  const reading = await observe(sessionId, runtime);
  if ("reason" in reading) return unavailable(reading.reason);
  const keys = keystrokesFor(reading.rows, desired);
  if (keys.length > 0) {
    try {
      await runtime.send(reading.pane, new TextEncoder().encode(keys));
    } catch (error) {
      if (error instanceof TmuxUnavailable) return unavailable("tmux-unavailable");
      throw error;
    }
  }
  // No hint: whatever Claude was offering, the box now holds what was asked for instead. An empty
  // push is the one case where a suggestion comes back, and the watcher reports it a moment later.
  return { text: desired, hint: null, reason: null, wrapped: false };
}

/** Presses Return in the pane, which is what makes Claude take the turn. */
export async function submitTmuxComposer(
  sessionId: string,
  runtime: TmuxComposerRuntime = LIVE,
): Promise<TmuxComposerState> {
  return press(sessionId, CARRIAGE_RETURN, { text: "", hint: null, reason: null, wrapped: false }, runtime);
}

/**
 * Presses Tab, which is how Claude's own suggestion becomes text in its box.
 *
 * Deliberately a key rather than a push of the hint's text. What the suggestion means, and what
 * accepting it does, belong to Claude: pushing the words back would be this module deciding that
 * accepting is the same as typing them, which is true only until it is not.
 *
 * What the box then holds is not guessed at here. The watcher reads the pane and says.
 */
export async function acceptTmuxComposerHint(
  sessionId: string,
  runtime: TmuxComposerRuntime = LIVE,
): Promise<TmuxComposerState> {
  return press(sessionId, TAB, { text: null, hint: null, reason: null, wrapped: false }, runtime);
}

/** One key into the session's pane, with the state to report when it lands. */
async function press(
  sessionId: string,
  key: string,
  landed: TmuxComposerState,
  runtime: TmuxComposerRuntime,
): Promise<TmuxComposerState> {
  let pane: string | null;
  try {
    pane = await runtime.pane(sessionId);
  } catch (error) {
    if (error instanceof TmuxUnavailable) return unavailable("tmux-unavailable");
    throw error;
  }
  if (!pane) return unavailable("no-pane");
  try {
    await runtime.send(pane, new TextEncoder().encode(key));
  } catch (error) {
    if (error instanceof TmuxUnavailable) return unavailable("tmux-unavailable");
    throw error;
  }
  return landed;
}

function unavailable(reason: NonNullable<TmuxComposerState["reason"]>): TmuxComposerState {
  return { text: null, hint: null, reason, wrapped: false };
}

/** The pane and its composer rows, or the reason there are none. */
async function observe(
  sessionId: string,
  runtime: TmuxComposerRuntime,
): Promise<
  (ComposerBox & { pane: string }) | { reason: NonNullable<TmuxComposerState["reason"]> }
> {
  let pane: string | null;
  try {
    pane = await runtime.pane(sessionId);
  } catch (error) {
    if (error instanceof TmuxUnavailable) return { reason: "tmux-unavailable" };
    throw error;
  }
  if (!pane) return { reason: "no-pane" };
  let screen: string;
  try {
    screen = await runtime.screen(pane);
  } catch (error) {
    if (error instanceof TmuxUnavailable) return { reason: "tmux-unavailable" };
    throw error;
  }
  const box = composerBox(screen);
  if (!box) return { reason: "no-composer" };
  return { pane, ...box };
}
