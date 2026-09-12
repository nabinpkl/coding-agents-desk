/**
 * Driving Claude's own `/rewind` in a tmux pane, to move a session back to a chosen message.
 *
 * This exists because there is no other way in. `/rewind` is defined with `argumentHint: ""` and
 * `supportsNonInteractive: false`: it takes no target and opens a picker, and nothing else in the
 * CLI moves a conversation's point. The alternative would be writing a truncated transcript
 * ourselves, which this repository refuses for the reason `renameSession.ts` gives -- one writer
 * per transcript is the version with no concurrency question in it. So the CLI is asked, the way
 * `/rename` is asked, and the cost is that the answer has to be read off a screen.
 *
 * Everything below is a measured property of Claude Code 2.1.266 on a 120x40 pane, taken by hand
 * before any of it was written:
 *
 *   The picker draws a title row `Rewind`, a line beginning `Restore the code and/or
 *   conversation`, then one entry per message of the LIVE conversation, oldest first, then a final
 *   `(current)` row, then `Enter to continue · Esc to cancel`.
 *
 *   Each entry is TWO rows: the message text, and under it a dim status row (`⚠ No code restore`,
 *   or `No code changes`). The status row is not parsed for meaning, only skipped, because its
 *   wording varies with what the turn touched and nothing here needs it.
 *
 *   The selected row carries `❯` where the others have two more spaces of indent. Colour agrees
 *   -- bold `38;5;153` against plain -- but the marker is what is read, because it is structural
 *   rather than a colour scheme's opinion. The gap after the marker may be a NO-BREAK space, as it
 *   is in the composer, so both are accepted.
 *
 *   IT OPENS ON `(current)`, the row below the newest message. That is the only fixed point this
 *   has, and it is what makes the target addressable: N presses of Up from there is the Nth
 *   message back from the newest. Up CLAMPS at the top rather than wrapping, measured with six
 *   presses against four positions, so an overshoot lands on the oldest entry instead of somewhere
 *   unpredictable -- and is then caught by the text check rather than acted on.
 *
 *   Enter opens a SECOND menu, numbered, whose options depend on what is available:
 *   `Restore conversation`, `Restore code`, `Restore code and conversation`, `Summarize from
 *   here`, `Summarize up to here`, `Never mind`. Its order moves with availability, so the option
 *   is found by LABEL and never by number.
 *
 *   Escape closes either menu and hands the composer back as it was. That is the abort path for
 *   every refusal here.
 *
 * Two rules follow from all of it, and they are the ones to keep if this is ever rewritten:
 *
 * - **The position picks the entry; the text decides whether to go through with it.** Counting is
 *   how you get there and is not evidence you arrived. If the row the selection lands on does not
 *   say what the caller was told it says, this presses Escape and refuses. A rewind to the wrong
 *   message is silent and unrecoverable; a refusal is neither.
 * - **Conversation only, always.** `Restore code` would roll files back in a checkout that several
 *   sessions share, which is not this feature's to do. The label is matched exactly, and an absent
 *   one is a refusal rather than a fallback to whatever else is on the menu.
 */
import { bytesForRailKey } from "@agentdesk/agent-feed-wire";
import {
  captureTmuxPaneView,
  hexSend,
  TmuxUnavailable,
  type TmuxPaneView,
} from "../terminal/tmuxSessions.ts";
import { liveTmuxSession } from "../terminal/agentTerminalService.ts";
import {
  composerBox,
  composerText,
  inTurn,
  keystrokesFor,
  plainText,
} from "./tmuxComposer.ts";

/** The glyph Claude puts on the selected row of a list. */
const MARKER = "\u276f";
/** The option this always takes. Matched exactly: `Restore code and conversation` is not it. */
const CONVERSATION_ONLY = "Restore conversation";
const CARRIAGE_RETURN = "\r";

/**
 * The arrows and Escape, taken from the wire's own table rather than spelled here.
 *
 * `bytesForRailKey` is where this repository decides what a named key is on the way to a pty, and
 * the phone's key rail already goes through it. A second spelling would be a second answer to
 * one question, and the kind that shows up as a pane that beeps rather than as a type error.
 */
const ESCAPE = bytesForRailKey("escape");
const UP = bytesForRailKey("up");
const DOWN = bytesForRailKey("down");
/** How long to wait for a pane to redraw after a key, and how often to look while waiting. */
const REDRAW_LIMIT_MS = 4_000;
const REDRAW_POLL_MS = 25;
/**
 * The furthest back this will walk.
 *
 * Not a limit on how old a message may be -- it is a limit on how long this may hold a pane while
 * reading it after every keypress. A rewind further back than this is better served by forking the
 * whole session, which costs no keystrokes at all.
 */
export const MAX_REWIND_STEPS = 200;

/** One message the picker is offering, as it renders it. */
export interface RewindEntry {
  /** The message text, which the picker may have truncated. */
  text: string;
  selected: boolean;
}

/** The message list, which is what `/rewind` opens with. */
export interface RewindMessages {
  kind: "messages";
  /** Oldest first, the order the picker draws them in. `(current)` is not one of these. */
  entries: RewindEntry[];
  /** Whether the row below the newest message is the selected one, which is where it opens. */
  currentSelected: boolean;
}

/** The numbered menu Enter opens on a chosen message. */
export interface RewindConfirm {
  kind: "confirm";
  options: { label: string; selected: boolean }[];
}

export type RewindScreen = RewindMessages | RewindConfirm | null;

export type RewindRefusal =
  | "no-pane"
  | "no-composer"
  | "composer-busy"
  | "no-picker"
  | "not-at-current"
  | "wrong-message"
  | "no-conversation-option"
  | "still-open"
  | "tmux-unavailable";

export type RewindOutcome =
  | {
    rewound: true;
    /**
     * What the composer holds now.
     *
     * Rewinding puts the rewound-to message back in the box to be edited, which is the point of
     * the feature for a person and a surprise for a caller that did not ask for it. Reported
     * rather than cleared here: whether to type over it is the caller's decision, and
     * `keystrokesFor` replaces box contents properly when it does.
     */
    composer: string;
  }
  | { rewound: false; reason: RewindRefusal };

/** Where in the conversation to land, and what proves it. */
export interface RewindTarget {
  /**
   * How many messages back from the newest, counting the newest as 1.
   *
   * Counted from the END rather than the start because the picker's fixed point is its opening
   * selection, and because the list SCROLLS: with `more above` on screen the topmost visible row
   * is not the first message, so an index from the top would address a different entry depending
   * on how much history there is.
   */
  fromEnd: number;
  /** What that message should say. The rewind is refused if the row does not agree. */
  text: string;
}

/** Everything this needs from tmux, injected so the suite needs no tmux server. */
export interface RewindRuntime {
  pane: (sessionId: string) => Promise<string | null>;
  screen: (pane: string) => Promise<TmuxPaneView>;
  send: (pane: string, bytes: Uint8Array) => Promise<void>;
  /** Overridable so a test does not spend the live redraw budget proving a refusal. */
  redrawLimitMs?: number;
  wait?: (ms: number) => Promise<void>;
}

const LIVE: RewindRuntime = {
  pane: (sessionId) => liveTmuxSession("claude", sessionId),
  screen: captureTmuxPaneView,
  send: hexSend,
};

/**
 * Which of Claude's rewind screens this is, or null when it is neither.
 *
 * Null is the ordinary answer for a pane mid-redraw as well as for one showing no menu at all, and
 * this deliberately does not try to tell those apart: the composer module measured that tmux
 * cannot (`#{cursor_flag}` reads the same during a repaint as during a dialog), so the caller
 * polls instead of guessing.
 */
export function rewindScreen(view: TmuxPaneView): RewindScreen {
  const raw = view.screen.split("\n");
  const lines = raw.map(plainText);
  const confirm = confirmMenu(lines);
  if (confirm) return confirm;
  return messageList(lines);
}

function messageList(lines: readonly string[]): RewindMessages | null {
  const title = lines.findIndex((line) => line.trim() === "Rewind");
  if (title < 0) return null;
  const footer = lines.findIndex((line, index) => index > title && line.includes("Esc to cancel"));
  if (footer < 0) return null;

  const entries: RewindEntry[] = [];
  let currentSelected = false;
  // Entries alternate with their status rows, so the status is skipped by POSITION -- the row
  // after an entry -- rather than by matching its words. Its wording moves with what the turn
  // touched (`⚠ No code restore`, `No code changes`, and whatever a turn that edited files says),
  // and a parser that knew those would quietly promote the next new one to a message.
  let expectStatus = false;
  for (let index = title + 1; index < footer; index += 1) {
    const row = entryRow(lines[index]!);
    if (!row) continue;
    if (row.text === "(current)") {
      currentSelected = row.selected;
      expectStatus = false;
      continue;
    }
    if (expectStatus) {
      expectStatus = false;
      continue;
    }
    entries.push(row);
    expectStatus = true;
  }
  return entries.length > 0 || currentSelected
    ? { kind: "messages", entries, currentSelected }
    : null;
}

const ENTRY = /^ {2}(\u276f[ \u00a0]| {2})(.*)$/;

/** One row of a list, and whether it is the selected one. Null when the row is not one. */
function entryRow(line: string): RewindEntry | null {
  const match = ENTRY.exec(line);
  if (!match) return null;
  const text = match[2]!.trim();
  if (!text) return null;
  return { text, selected: match[1]!.startsWith(MARKER) };
}

const OPTION = /^ {2}(\u276f[ \u00a0]| {2})\d+\.\s+(.*)$/;

function confirmMenu(lines: readonly string[]): RewindConfirm | null {
  const options: { label: string; selected: boolean }[] = [];
  for (const line of lines) {
    const match = OPTION.exec(line);
    if (!match) continue;
    options.push({ label: match[2]!.trim(), selected: match[1]!.startsWith(MARKER) });
  }
  return options.length > 0 ? { kind: "confirm", options } : null;
}

/**
 * Whether a picker row is the message the caller meant.
 *
 * Lenient about the END and strict about the start, because the picker truncates a long message
 * and nothing here should have to know its width. Whitespace is collapsed on both sides: a message
 * written over several lines arrives on the screen as one row.
 */
export function saysTheSame(entry: string, target: string): boolean {
  const shown = collapse(entry).replace(/[.…]+$/, "").trim();
  const wanted = collapse(target);
  return shown.length > 0 && (wanted === collapse(entry) || wanted.startsWith(shown));
}

function collapse(value: string): string {
  return value.replace(/[\s\u00a0]+/g, " ").trim();
}

/**
 * Rewinds one session to a chosen message, conversation only.
 *
 * Takes the pane's turn the same way a composer push does, so a rewind and somebody typing cannot
 * be sending into one box at once.
 */
export async function rewindTmuxSession(
  sessionId: string,
  target: RewindTarget,
  runtime: RewindRuntime = LIVE,
): Promise<RewindOutcome> {
  return inTurn(sessionId, async () => {
    let pane: string | null = null;
    try {
      pane = await runtime.pane(sessionId);
      if (!pane) return refused("no-pane");
      return await drive(pane, target, runtime);
    } catch (error) {
      // Best effort, and after the failure rather than instead of reporting it: a pane left with a
      // menu open is one nobody can type into, which is worse than the refusal that got us here.
      if (pane) await escape(pane, runtime).catch(() => {});
      return refused(error instanceof TmuxUnavailable ? "tmux-unavailable" : "no-pane");
    }
  });
}

async function drive(
  pane: string,
  target: RewindTarget,
  runtime: RewindRuntime,
): Promise<RewindOutcome> {
  if (target.fromEnd < 1 || target.fromEnd > MAX_REWIND_STEPS) return refused("wrong-message");

  const box = composerBox(await runtime.screen(pane));
  if (!box) return refused("no-composer");
  // The same refusal the rename makes, for the same reason: the only way to run a command in a box
  // is to type it where the reader was writing.
  if (composerText(box.rows).length > 0) return refused("composer-busy");

  // Pasted rather than typed, which is what stops the leading `/` opening the command menu while
  // still being dispatched as a command. Measured on the rename path 2026-09-07.
  await send(pane, runtime, keystrokesFor(box, "/rewind") + CARRIAGE_RETURN);

  const opened = await settle(pane, runtime, (screen) => screen?.kind === "messages");
  if (opened?.kind !== "messages") return await abort(pane, runtime, "no-picker");
  // The one fixed point there is. A picker that opened anywhere else is one whose position this
  // cannot reason about, so it is refused rather than counted from.
  if (!opened.currentSelected) return await abort(pane, runtime, "not-at-current");

  let list = opened;
  let showing = (await runtime.screen(pane)).screen;
  for (let step = 0; step < target.fromEnd; step += 1) {
    await send(pane, runtime, UP);
    // Waited for by DIFFERENCE, not by "is it still a list", which is the composer module's
    // lesson at a different menu. The list is already a list before the redraw lands, so a
    // predicate about its kind is satisfied by the screen from before the key -- and the loop
    // would then walk N times reading a selection N-1 presses old.
    const moved = await settleChanged(pane, runtime, showing);
    if (moved.screen?.kind !== "messages") return await abort(pane, runtime, "no-picker");
    list = moved.screen;
    // Nothing moved, so the selection is against the top. Up clamps rather than wrapping
    // (measured), so walking further would spend the redraw budget once per remaining step and
    // arrive at the same row. Stop, and let the text check below decide whether that row is the
    // one that was asked for -- which it is, when the target IS the oldest message.
    if (!moved.changed) break;
    showing = moved.showing;
  }

  const landed = list.entries.find((entry) => entry.selected);
  // Covers both ways the count can be wrong: a list shorter than the caller believed clamps at the
  // oldest entry, and a list that offers a different set lands on a different message. Neither is
  // distinguishable from success without this, and both are silent if it is skipped.
  if (!landed || !saysTheSame(landed.text, target.text)) {
    return await abort(pane, runtime, "wrong-message");
  }

  await send(pane, runtime, CARRIAGE_RETURN);
  const confirm = await settle(pane, runtime, (screen) => screen?.kind === "confirm");
  if (confirm?.kind !== "confirm") return await abort(pane, runtime, "no-picker");

  const wanted = confirm.options.findIndex((option) => option.label === CONVERSATION_ONLY);
  // No fallback to whatever else is on the menu. The other options restore files or summarize, and
  // either would be this doing something nobody asked for.
  if (wanted < 0) return await abort(pane, runtime, "no-conversation-option");

  const settled = await selectOption(pane, runtime, wanted);
  if (!settled) return await abort(pane, runtime, "no-conversation-option");

  await send(pane, runtime, CARRIAGE_RETURN);
  const closed = await settle(pane, runtime, (screen) => screen === null);
  if (closed !== null) return await abort(pane, runtime, "still-open");

  const after = composerBox(await runtime.screen(pane));
  return { rewound: true, composer: after ? composerText(after.rows) : "" };
}

/** Walks the confirm menu's highlight onto `wanted`, one key at a time, reading between each. */
async function selectOption(
  pane: string,
  runtime: RewindRuntime,
  wanted: number,
): Promise<boolean> {
  for (let step = 0; step <= MAX_REWIND_STEPS; step += 1) {
    const screen = await settle(pane, runtime, (view) => view?.kind === "confirm");
    if (screen?.kind !== "confirm") return false;
    const at = screen.options.findIndex((option) => option.selected);
    if (at === wanted) return true;
    // Nothing is assumed about where the highlight starts, because the menu's own order moves with
    // what is available; the direction is read off the screen each time.
    if (at < 0) return false;
    await send(pane, runtime, at < wanted ? DOWN : UP);
  }
  return false;
}

async function abort(
  pane: string,
  runtime: RewindRuntime,
  reason: RewindRefusal,
): Promise<RewindOutcome> {
  await escape(pane, runtime).catch(() => {});
  return refused(reason);
}

/**
 * Closes whatever is open, twice.
 *
 * Once for the confirm menu and once for the list behind it, because a refusal can happen at
 * either depth and Escape only closes the top one. A spare Escape at an ordinary composer clears
 * a box this has already established is empty, so the extra one costs nothing.
 */
async function escape(pane: string, runtime: RewindRuntime): Promise<void> {
  await send(pane, runtime, ESCAPE);
  await send(pane, runtime, ESCAPE);
}

function send(pane: string, runtime: RewindRuntime, keys: string): Promise<void> {
  return runtime.send(pane, new TextEncoder().encode(keys));
}

/**
 * Reads the pane until it shows what was asked for, or the budget runs out.
 *
 * Polling rather than one read, because a key's redraw takes tens of milliseconds and a capture
 * taken inside it shows neither the old screen nor the new one. Returns whatever the last read
 * saw, so the caller reports what it actually found rather than a timeout.
 */
async function settle(
  pane: string,
  runtime: RewindRuntime,
  wanted: (screen: RewindScreen) => boolean,
): Promise<RewindScreen> {
  return (await poll(pane, runtime, (view) => wanted(rewindScreen(view)))).screen;
}

/**
 * Reads until the pane is showing something other than `showing`.
 *
 * `changed` is false when the budget ran out with the screen identical, which at this menu means
 * the selection is against a stop rather than that the pane is slow.
 */
async function settleChanged(
  pane: string,
  runtime: RewindRuntime,
  showing: string,
): Promise<{ screen: RewindScreen; showing: string; changed: boolean }> {
  const settled = await poll(pane, runtime, (view) => view.screen !== showing);
  return { ...settled, changed: settled.showing !== showing };
}

async function poll(
  pane: string,
  runtime: RewindRuntime,
  wanted: (view: TmuxPaneView) => boolean,
): Promise<{ screen: RewindScreen; showing: string }> {
  const limit = runtime.redrawLimitMs ?? REDRAW_LIMIT_MS;
  const wait = runtime.wait ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const started = Date.now();
  let view = await runtime.screen(pane);
  while (!wanted(view)) {
    if (Date.now() - started >= limit) break;
    await wait(REDRAW_POLL_MS);
    view = await runtime.screen(pane);
  }
  return { screen: rewindScreen(view), showing: view.screen };
}

function refused(reason: RewindRefusal): RewindOutcome {
  return { rewound: false, reason };
}
