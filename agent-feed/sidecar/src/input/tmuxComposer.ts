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

import {
  bytesForRailKey,
  NO_MODIFIERS,
  type RailKey,
  type RailModifiers,
  type TmuxComposerState,
} from "@agentdesk/agent-feed-wire";
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

/**
 * What Claude collapses an attachment into, and treats as a SINGLE character.
 *
 * Measured on a live pane, both kinds. With `[Image #2] omega` in the box, six backspaces rubbed
 * out " omega" one character at a time and the SEVENTH took the whole token; the same held for
 * `[Pasted text #3 +38 lines]`, twenty-six characters that went in one press. So the count of
 * backspaces a correction needs is not the length of the text being removed, and a diff that used
 * the length would delete as many extra characters to the left as the token is long.
 *
 * Both kinds matter even though the panel only ever creates images: a person typing in the pane
 * makes the other one by pasting anything long, and this side has to read their box correctly.
 */
const ATTACHMENT = /\[(?:Image|Pasted text) #\d+(?: \+\d+ lines)?\]/g;

/** Kill to the start of the visual row. One per row is what empties the box. */
const KILL_ROW = "\u0015";
const BACKSPACE = "\u007f";
const CARRIAGE_RETURN = "\r";
/** What accepts Claude's suggestion. Measured: the row comes back with no faint run at all. */
const TAB = "\t";
/**
 * Ctrl+E, which puts the cursor after the last character of the WHOLE box.
 *
 * Every edit this module computes assumes the text ends at the cursor: a backspace bites to the
 * left of it, a paste lands at it, and one Ctrl+U per row clears the box only if the cursor starts
 * on the last of them. Nothing made that true, and a reader breaks it by tapping into the middle
 * of their own sentence to fix a typo -- or, now, by pressing the key rail's own arrows. So the
 * assumption is made true rather than assumed, by going to the end first.
 *
 * It is Ctrl+E rather than End, and that difference IS the bug this replaces. Measured 2026-09-08
 * on a live pane against tmux's own `#{cursor_x}`/`#{cursor_y}` rather than inferred from the
 * text: both spellings of End (`ESC [ F` and `ESC O F`) are end-of-VISUAL-LINE. On a wrapped box
 * with the cursor on the first row they left it at the wrap boundary, so the row-count clear then
 * killed upward from the middle and every row BELOW the cursor survived -- a box cleared that way
 * came back still holding `the end`, and the paste that followed landed on top of it. The reader
 * sees their words twice. Ctrl+E from that same position reached the true end of the buffer, and
 * the identical clear emptied the box.
 *
 * The note that used to stand here said Ctrl+E does not move Claude's cursor. That was measured on
 * a single-row box, where end-of-line and end-of-buffer are the same column and no key can be told
 * apart from any other.
 */
const END = "\u0005";
const PASTE_START = "\u001b[200~";
const PASTE_END = "\u001b[201~";

/**
 * How much text the panel may push into somebody's pane.
 *
 * Smaller than the terminal input route's own 64 KiB ceiling, deliberately: that one bounds a
 * turn sent once, and this one bounds text that is retyped every time a guess misses.
 */
export const MAXIMUM_COMPOSER_BYTES = 16 * 1024;

/**
 * How long a send is given to reach the screen, and how often the screen is asked.
 *
 * Measured 2026-09-07 against a live pane, ten trials: the pasted text appeared in `capture-pane`
 * between 21ms and 46ms after `send-keys` returned, against a whole request that took about
 * 110ms. The limit is an order of magnitude past the worst of those because it is not a deadline
 * anything depends on -- it is where waiting stops being worth it and the next reader takes its
 * chances, which is the behaviour this module had everywhere before.
 *
 * The interval is smaller than a capture costs, so what actually paces the loop is tmux.
 */
const REDRAW_LIMIT_MS = 400;
const REDRAW_POLL_MS = 5;

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
  // Every branch below is written as though the text ends at the cursor. Going to the end is what
  // makes that so, and it is free when the cursor is already there.
  if (current.length > 0 && desired.startsWith(current)) {
    return END + paste(desired.slice(current.length));
  }
  // A single row is known exactly, so a correction rubs out only what diverged -- which keeps a
  // backspace in the panel costing a backspace in the pane rather than a whole retype.
  if (rows.length === 1) {
    const shared = sharedPrefix(current, desired);
    const removed = backspacesFor(current.slice(shared));
    return END + BACKSPACE.repeat(removed) + paste(desired.slice(shared));
  }
  return END + KILL_ROW.repeat(rows.length) + paste(desired);
}

/** Nothing to insert sends nothing: an empty bracketed paste still makes Claude redraw the box. */
function paste(text: string): string {
  if (text.length === 0) return "";
  // A composer's own text can contain an escape, and it must arrive as one visible character
  // rather than as the start of a sequence the pane will act on. Same guard the terminal prompt
  // route makes, for the same reason.
  return `${PASTE_START}${text.replaceAll("\u001b", "\u241b")}${PASTE_END}`;
}

/**
 * How many backspaces rub out `text`, which is not how long it is.
 *
 * Each attachment token goes in one press; everything else goes by code point, so an emoji costs
 * one backspace rather than two.
 */
function backspacesFor(text: string): number {
  return [...text.replaceAll(ATTACHMENT, "\u0000")].length;
}

/**
 * How much of `current` to keep, which is the shared prefix moved back off any token it split.
 *
 * A prefix that ends inside a token would have the rest of that token counted character by
 * character and then deleted whole, taking the neighbours with it. Backing up to the token's start
 * costs one extra press and cannot be wrong.
 */
function sharedPrefix(current: string, desired: string): number {
  let shared = commonPrefix(current, desired).length;
  for (const token of current.matchAll(ATTACHMENT)) {
    const start = token.index;
    if (shared > start && shared < start + token[0].length) shared = start;
  }
  return shared;
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

/**
 * The pane each live watch is sitting on, published so a push does not have to go and find one.
 *
 * Resolving a pane is the expensive act in this module: it reads every session record on disk and
 * asks the kernel about each pid, which is a `ps` per record and about fifty milliseconds. Doing
 * it per keystroke burst is pure waste, because a watch resolved that same pane when it opened and
 * has been holding it ever since -- the panel cannot push at all without one, since the band that
 * owns the field only appears once a watch has reported.
 *
 * Held rather than cached: an entry exists for exactly as long as a watch is on it, so it cannot
 * go stale sitting in a map nobody is looking at. A caller that finds nothing held goes and
 * resolves, which is what keeps a push working across the gap while a dropped stream reconnects.
 */
export interface TmuxComposerPanes {
  /** Records the pane a watch is on, until the returned function is called. */
  hold: (sessionId: string, pane: string) => () => void;
  /** The pane a watch is holding for this session, or null when none is. */
  get: (sessionId: string) => string | null;
  /** Drops a pane that stopped answering, so the next caller goes and looks again. */
  forget: (sessionId: string) => void;
}

export function composerPanes(): TmuxComposerPanes {
  /** A token per watch rather than a count, so two panels on one session hold it independently. */
  const held = new Map<string, Set<{ pane: string }>>();
  return {
    hold(sessionId, pane) {
      const token = { pane };
      const holders = held.get(sessionId) ?? new Set<{ pane: string }>();
      holders.add(token);
      held.set(sessionId, holders);
      return () => {
        holders.delete(token);
        // Only if this set is still the one on the map. A `forget` between the hold and the
        // release detaches it, and a later watch puts its own there; deleting by key alone would
        // then drop that watch's pane on this one's way out.
        if (holders.size === 0 && held.get(sessionId) === holders) held.delete(sessionId);
      };
    },
    get(sessionId) {
      for (const token of held.get(sessionId) ?? []) return token.pane;
      return null;
    },
    forget(sessionId) {
      held.delete(sessionId);
    },
  };
}

/**
 * The turn in progress on each session's box, so a second one waits rather than interleaving.
 *
 * Every function here that touches a composer READS the screen and then WRITES to it, and those
 * two halves are not atomic. Two of them overlapping is not a rare race: the panel debounces at
 * 90ms and a push over a slow link takes longer than that, so a reader typing normally has a
 * second push starting before the first has landed. Both read the same box, both compute their
 * keystrokes from it, and both paste their whole text.
 *
 * Measured 2026-09-07, two pushes fired together at an empty box, "hello wor" and "hello world
 * now": the box ended up holding `hello world nowhello wor`, and each request answered 200 with
 * its own text, so nothing anywhere reported a problem. That is the shape the reader sees -- every
 * draft they typed, concatenated in the order the sends happened to land.
 *
 * Process-wide rather than per-runtime, because the thing being serialised is the pane, and the
 * two live surfaces (a phone and a Mac, both real, both able to drive one session) reach it
 * through different requests.
 *
 * On `globalThis` rather than in this module, and that is not ceremony. The sidecar runs under
 * `bun --watch`, which re-reads a changed module IN PROCESS and rebinds the port without the
 * supervisor ever seeing an exit -- so module-level state is discarded while the requests already
 * running are not. A plain `const` here would hand the reloaded module an empty map, and the turns
 * still in flight from the previous one would be serialised against nothing: two of them on one
 * box again, which is the whole defect coming back at exactly the moment somebody is editing this
 * file. Measured 2026-09-07: both sidecars re-executed at 20:11:27 while a reader was typing, and
 * that reader got their draft back concatenated.
 */
const TURN_STORE = Symbol.for("agentdesk.composerTurns");
const TURNS: Map<string, Promise<void>> =
  ((globalThis as Record<symbol, unknown>)[TURN_STORE] ??= new Map<string, Promise<void>>()) as
    Map<string, Promise<void>>;

/**
 * Runs `work` after whatever is already in flight for this session, and reports its own result.
 *
 * The chain the next caller waits on is one that never rejects, so a failed turn holds nothing up
 * and cannot re-throw into an unrelated caller. The map entry is dropped when the chain drains,
 * which keeps this from being a per-session leak in a sidecar that sees thousands of them.
 */
function inTurn<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
  const result = (TURNS.get(sessionId) ?? Promise.resolve()).then(work);
  const drained = result.then(() => {}, () => {});
  TURNS.set(sessionId, drained);
  void drained.then(() => {
    if (TURNS.get(sessionId) === drained) TURNS.delete(sessionId);
  });
  return result;
}

/**
 * Waits for the pane to redraw from a send, so the next turn reads the box and not its past.
 *
 * Serialising the turns is only half of it. The second turn still starts by reading the screen,
 * and the screen does not carry what was just sent for another few tens of milliseconds -- so
 * without this it reads the box as it was BEFORE the previous turn, computes a diff against text
 * that is already gone, and corrupts the pane exactly as two concurrent turns would.
 *
 * What it waits for is the reading being DIFFERENT, not the reading being right. A composer whose
 * text wraps cannot be reconstructed exactly (see the header), so waiting for it to equal what was
 * asked for would spin out the full limit on every wrapped push. Difference is observable in every
 * case and is the actual question: has this send reached the screen yet.
 *
 * A box that reads as nothing at all is a pane mid-redraw, which is not an answer either way, so
 * it keeps waiting. Passing `null` says there is nothing to wait for and returns at once.
 *
 * It swallows its own failures, which is the one place in this module that is right. The send has
 * already happened by the time this runs, so a tmux that stops answering DURING the wait says
 * nothing about whether the push landed -- and letting that throw would report a push that reached
 * the box as a session with no tmux, clearing the held pane on the way out. Waiting simply stops;
 * the next turn reads the pane and reports what it finds.
 */
async function settle(
  pane: string,
  before: string | null,
  runtime: TmuxComposerRuntime,
): Promise<void> {
  if (before === null) return;
  const deadline = Date.now() + REDRAW_LIMIT_MS;
  while (Date.now() < deadline) {
    await new Promise((wake) => setTimeout(wake, REDRAW_POLL_MS));
    let screen: string;
    try {
      screen = await runtime.screen(pane);
    } catch {
      return;
    }
    const box = composerBox(screen);
    if (box && composerText(box.rows) !== before) return;
  }
}

/** Everything the live functions need from tmux, injected so the suite needs no tmux server. */
export interface TmuxComposerRuntime {
  /**
   * Finds which tmux session a Claude session is running in, from scratch.
   *
   * The expensive call, and the reason `panes` exists. Reached only by a watch opening, or by a
   * push that arrives with nothing watching.
   */
  pane: (sessionId: string) => Promise<string | null>;
  screen: (pane: string) => Promise<string>;
  send: (pane: string, bytes: Uint8Array) => Promise<void>;
  panes: TmuxComposerPanes;
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
  // One registry for the process, so a watch opened through the routes is visible to a push that
  // took the default runtime. Two would be two answers to one question.
  panes: composerPanes(),
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
 * The pane is resolved ONCE, here, and then held for everything that follows: this watch's own
 * reads, and every push the panel makes while it lasts. A session's pane does not move under it,
 * so finding it again per read or per keystroke would be paying fifty milliseconds to be told the
 * same thing.
 *
 * A session with no pane ENDS rather than waiting: there is nothing to hang a pipe on, and a
 * session gains a pane later often enough to matter -- pressing the band's own terminal button
 * resumes one. Ending hands the retry to whoever asked, where a stream that stayed open would
 * have to grow a timer to notice, which is the thing this replaced.
 *
 * A pane that DIES is not noticed here, and deliberately: the pipe simply goes quiet. It is
 * noticed at the next push, whose tmux call fails and drops the held pane -- the same place
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
  let release: (() => void) | null = null;
  /** Resolved once, at the top, and used by every read this watch makes. */
  let pane: string | null = null;

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
    if (stopped || reading || pane === null) return;
    reading = true;
    try {
      report(await readComposerAt(pane, runtime));
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
    let found: string | null;
    try {
      found = await runtime.pane(sessionId);
    } catch {
      found = null;
    }
    if (stopped) return;
    if (!found) {
      report(unavailable("no-pane"));
      end();
      return;
    }
    try {
      const stop = await runtime.watch(found, schedule);
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
    pane = found;
    // Published only now, with the pipe actually set: a push against a pane this watch failed to
    // join should go and resolve for itself rather than take this one's word for it.
    release = runtime.panes.hold(sessionId, found);
    // The first reading is not waited for: a pane that is sitting idle writes nothing, so a
    // watcher that only spoke on output would say nothing at all until somebody typed.
    await readNow();
  })();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    unwatch?.();
    release?.();
  };
}

/** What the composer in `pane` is showing, or why it cannot be seen. */
export async function readComposerAt(
  pane: string,
  runtime: Pick<TmuxComposerRuntime, "screen">,
): Promise<TmuxComposerState> {
  let box: ComposerBox | null;
  try {
    box = composerBox(await runtime.screen(pane));
  } catch (error) {
    if (error instanceof TmuxUnavailable) return unavailable("tmux-unavailable");
    throw error;
  }
  if (!box) return unavailable("no-composer");
  return {
    text: composerText(box.rows),
    hint: box.hint,
    reason: null,
    wrapped: box.rows.length > 1,
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
  return inTurn(sessionId, async () => {
    try {
      const pane = await paneFor(sessionId, runtime);
      if (!pane) return unavailable("no-pane");
      const box = composerBox(await runtime.screen(pane));
      if (!box) return unavailable("no-composer");
      const keys = keystrokesFor(box.rows, desired);
      if (keys.length > 0) {
        await runtime.send(pane, new TextEncoder().encode(keys));
        await settle(pane, composerText(box.rows), runtime);
      }
      // No hint: whatever Claude was offering, the box now holds what was asked for instead. An
      // empty push is the one case where a suggestion comes back, and the watcher reports it a
      // moment later.
      return { text: desired, hint: null, reason: null, wrapped: false };
    } catch (error) {
      return failed(sessionId, error, runtime);
    }
  });
}

/**
 * Puts the image at `path` into the session's composer, by pasting the path the way a drop does.
 *
 * A bare paste rather than a `sync`, and the difference matters: Claude's paste handler reads the
 * text of THIS paste to decide whether it is looking at a file path, so the path has to arrive on
 * its own. A sync that appended it to the box would send exactly the same bytes while the box
 * agrees, and on the one push where it does not, would clear and retype the whole composer as a
 * single paste -- which parses as one image plus everything else as text, in the wrong order.
 *
 * The separating space is sent OUTSIDE the paste, as an ordinary keystroke. Measured: a paste of
 * " /tmp/x.png" splits on the space that precedes the slash and the empty half is dropped, so a
 * space put inside the paste never reaches the box at all.
 *
 * What the box then holds is not guessed at. Claude replaces the path with its own `[Image #N]`,
 * which is a different string from the one sent, so the watcher reads the pane and says.
 */
export async function dropTmuxComposerImage(
  sessionId: string,
  path: string,
  runtime: TmuxComposerRuntime = LIVE,
): Promise<TmuxComposerState> {
  return inTurn(sessionId, async () => {
    try {
      const pane = await paneFor(sessionId, runtime);
      if (!pane) return unavailable("no-pane");
      const box = composerBox(await runtime.screen(pane));
      if (!box) return unavailable("no-composer");
      const keys = separator(box) + paste(path);
      await runtime.send(pane, new TextEncoder().encode(keys));
      // Claude swaps the path for its own `[Image #N]`, so the box always ends up reading
      // differently. Waiting for that is what stops the next push diffing against a box that
      // still shows the moment before the drop.
      await settle(pane, composerText(box.rows), runtime);
      return { text: null, hint: null, reason: null, wrapped: false };
    } catch (error) {
      return failed(sessionId, error, runtime);
    }
  });
}

/**
 * A space, unless the box is empty.
 *
 * It cannot ask whether the text already ends in one: `capture-pane` strips a row's trailing
 * padding, so a composer ending in a space and one that does not are the same screen. A box that
 * really did end in a space therefore gets a second one, which is the same rounding the append
 * path already lives with and is invisible in a prompt.
 */
function separator(box: ComposerBox): string {
  return composerText(box.rows).length === 0 ? "" : " ";
}

/**
 * What a rename attempt did, or the reason it did nothing.
 *
 * `composer-busy` is the one reason that is not a failure: somebody has text in that box, and
 * renaming would type a command into the middle of what they were writing.
 */
export type SessionRenameOutcome =
  | { renamed: true }
  | { renamed: false; reason: TmuxComposerState["reason"] | "composer-busy" };

/**
 * Renames the session by running Claude's own `/rename`, in the pane the session is running in.
 *
 * The CLI is asked rather than its transcript written, because `/rename` changes BOTH of a
 * session's names -- it writes the `custom-title` record the panel reads AND the `agent-name`
 * record, and updates the process's registry `name`, which is the address `ListAgents` prints and
 * `SendMessage` uses. Appending a record from outside can only ever move the first of those, so a
 * session renamed that way keeps answering to its old name everywhere that matters for discovery.
 * It also means no second writer on a file the CLI owns.
 *
 * Sent as a bracketed paste, the same way every other insertion in this module goes: measured
 * 2026-09-07 that Claude dispatches a slash command that arrives pasted, so this avoids the
 * command menu that a typed leading `/` opens without giving up the dispatch.
 *
 * Runs even while the session is mid-turn, and does not interrupt it: measured against a session
 * counting to forty, which finished its count with the new name already on it.
 *
 * Refused when the composer holds anything, because the only way to type a command into a box is
 * to type it where the reader was writing.
 */
export async function renameTmuxSession(
  sessionId: string,
  title: string,
  runtime: TmuxComposerRuntime = LIVE,
): Promise<SessionRenameOutcome> {
  return inTurn(sessionId, async () => {
    try {
      const pane = await paneFor(sessionId, runtime);
      if (!pane) return { renamed: false, reason: "no-pane" };
      const box = composerBox(await runtime.screen(pane));
      if (!box) return { renamed: false, reason: "no-composer" };
      if (composerText(box.rows).length > 0) return { renamed: false, reason: "composer-busy" };
      const encoder = new TextEncoder();
      // One send, not two: the command and the Return travel together so nothing can be typed
      // between them into the box this just checked was empty.
      const keys = keystrokesFor(box.rows, `/rename ${title}`);
      await runtime.send(pane, encoder.encode(keys + CARRIAGE_RETURN));
      return { renamed: true };
    } catch (error) {
      const state = failed(sessionId, error, runtime);
      return { renamed: false, reason: state.reason };
    }
  });
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

/**
 * One key rail press into the session's pane.
 *
 * The composer band grew this for the same reason the terminal has a rail: a phone keyboard has no
 * Esc, no Tab, no Ctrl and no arrows, and those are most of how Claude's own prompt box is driven.
 * Reading a suggestion and pressing Tab already had a route of its own; everything else did not.
 *
 * The key arrives NAMED rather than as bytes. A route that took bytes would be a second way to
 * write anything at all into somebody's pane, and it would put the mapping from key to sequence in
 * whichever caller happened to send it -- so `bytesForRailKey` lives on the wire and both sides
 * read the same one.
 *
 * What the box then holds is not guessed at. An arrow moves a cursor and Escape may clear the
 * whole thing, neither of which this can predict, so the watcher reads the pane and says.
 */
export async function pressTmuxComposerKey(
  sessionId: string,
  key: RailKey,
  held: RailModifiers = NO_MODIFIERS,
  runtime: TmuxComposerRuntime = LIVE,
): Promise<TmuxComposerState> {
  return press(
    sessionId,
    bytesForRailKey(key, held),
    { text: null, hint: null, reason: null, wrapped: false },
    runtime,
  );
}

/**
 * One key into the session's pane, with the state to report when it lands.
 *
 * Queued behind whatever else is driving this box, but deliberately WITHOUT the redraw wait the
 * pushes do, because it would cost a screen read and this path is the one that must work when the
 * screen cannot be read at all -- a pane mid-redraw draws no composer, and a reader who has
 * pressed Return should not be told the session has no composer because of when they pressed it.
 *
 * What it gives up by not waiting is small enough to name. A push arriving before Return's redraw
 * reads the box as it was and computes backspaces for text that has already gone, and a backspace
 * on an empty composer does nothing -- so the retype lands correctly anyway. Tab is the one with a
 * real gap: the suggestion it takes is not on screen yet, so a push in that window can append to
 * it. The panel does not push there, it waits for the watcher to say what the box now holds.
 */
async function press(
  sessionId: string,
  key: string,
  landed: TmuxComposerState,
  runtime: TmuxComposerRuntime,
): Promise<TmuxComposerState> {
  return inTurn(sessionId, async () => {
    try {
      const pane = await paneFor(sessionId, runtime);
      if (!pane) return unavailable("no-pane");
      await runtime.send(pane, new TextEncoder().encode(key));
      return landed;
    } catch (error) {
      return failed(sessionId, error, runtime);
    }
  });
}

/**
 * The pane to type into: the one a live watch is already on, or a fresh resolution.
 *
 * The held one is not verified before it is used. Verifying it would cost the resolution this
 * exists to skip, and the tmux call about to be made is a better check than any preflight: it
 * either lands or it fails, and `failed` turns the failure into an answer.
 */
async function paneFor(sessionId: string, runtime: TmuxComposerRuntime): Promise<string | null> {
  return runtime.panes.get(sessionId) ?? await runtime.pane(sessionId);
}

/**
 * A tmux failure, turned into a reason -- and a held pane that failed is dropped on the way.
 *
 * This is where a session that ended is found out. A watch does not notice: the pipe simply goes
 * quiet, and tmux takes the session down with the process that was running in it. So the first
 * push after that reports `tmux-unavailable`, truthfully -- tmux really did refuse -- and drops
 * the pane, and the one after it resolves, finds no live process, and says `no-pane`, which is
 * what the reader needs to be told.
 */
function failed(
  sessionId: string,
  error: unknown,
  runtime: TmuxComposerRuntime,
): TmuxComposerState {
  if (!(error instanceof TmuxUnavailable)) throw error;
  runtime.panes.forget(sessionId);
  return unavailable("tmux-unavailable");
}

function unavailable(reason: NonNullable<TmuxComposerState["reason"]>): TmuxComposerState {
  return { text: null, hint: null, reason, wrapped: false };
}
