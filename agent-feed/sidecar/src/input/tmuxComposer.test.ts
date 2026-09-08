import { expect, test } from "bun:test";
import {
  acceptTmuxComposerHint,
  composerBox,
  type ComposerBox,
  composerText,
  keystrokesFor,
  composerPanes,
  dropTmuxComposerImage,
  observeTmuxComposer,
  readComposerAt,
  renameTmuxSession,
  submitTmuxComposer,
  syncTmuxComposer,
  type TmuxComposerRuntime,
  type TmuxComposerWatchRuntime,
} from "./tmuxComposer.ts";
import { TmuxUnavailable, type TmuxPaneView } from "../terminal/tmuxSessions.ts";

const RULE = "─".repeat(60);

/** Where the composer's text begins, which is what the module's own `BOX_COLUMN` measures. */
const BOX_COLUMN = 2;

/** How many lines stand above the prompt row in `screenWith`, so a cursor can be aimed at one. */
const ABOVE_PROMPT = 3;

/**
 * A pane as tmux answers for one: the screen `capture-pane` returns, and where the cursor is.
 *
 * The cursor defaults to the end of the last row, which is where a reader who has just typed
 * leaves it and what makes the reading exact. `cursor` overrides it with a row and a column
 * counted inside the box, which is how the inexact cases are written.
 */
function screenWith(
  rows: string[],
  cursor?: { row: number; column: number },
): TmuxPaneView {
  const last = Math.max(rows.length - 1, 0);
  const at = cursor ?? { row: last, column: (rows[last] ?? "").length };
  return {
    screen: [
      "  Some earlier output from the session.",
      "",
      RULE,
      // A no-break space after the marker, which is what a live pane actually writes.
      `❯\u00a0${rows[0] ?? ""}`,
      ...rows.slice(1).map((row) => `  ${row}`),
      RULE,
      "  adprobe  Opus 5 (1M context)                    0 tokens",
      "  ⏵⏵ auto mode on (shift+tab to cycle)                 /rc",
    ].join("\n"),
    cursor: { row: ABOVE_PROMPT + at.row, column: BOX_COLUMN + at.column },
  };
}

/** A hand-written screen, with the cursor put at the end of its last composer row. */
function paneShowing(screen: string, cursor?: { row: number; column: number }): TmuxPaneView {
  const lines = screen.split("\n");
  const head = lines.findLastIndex((line) => line.replace(/\u001b\[[0-9;]*m/g, "").startsWith("❯"));
  const text = (lines[head] ?? "").replace(/\u001b\[[0-9;]*m/g, "").slice(1).replace(/^[ \u00a0]/, "");
  const at = cursor ?? { row: 0, column: text.length };
  return { screen, cursor: { row: head + at.row, column: BOX_COLUMN + at.column } };
}

/**
 * A composer box read exactly, which is what a cursor sitting at the end of the last row means.
 *
 * The inexact case gets its own tests rather than a default, because it is the one that decides
 * between an incremental edit and a retype.
 */
function held(rows: string[]): ComposerBox {
  return { rows, hint: null, exact: true };
}

const KILL = "\u0015";
/** Ctrl+E, which every computed edit leads with so the text really does end at the cursor. */
const END = "\u0005";

/**
 * What a pane would actually show, given the bytes sent to it.
 *
 * The paste brackets and Ctrl+E are instructions, not characters: a real composer moves its
 * cursor and takes the text between the brackets. A fake that appended them verbatim would show
 * the escape sequences in the box and fail for the wrong reason.
 */
function typed(keys: string): string {
  return keys.replaceAll(END, "").replaceAll(OPEN, "").replaceAll(CLOSE, "");
}
const BACKSPACE = "\u007f";
const OPEN = "\u001b[200~";
const CLOSE = "\u001b[201~";

test("reads the composer box, and an empty one as empty rather than as absent", () => {
  expect(composerBox(screenWith(["make the hover ring stronger"])))
    .toEqual({ rows: ["make the hover ring stronger"], hint: null, exact: true });
  // The distinction the whole reconciliation rests on: "" is adopted into the field, null is not.
  expect(composerBox(screenWith([]))).toEqual({ rows: [""], hint: null, exact: true });
});

test("keeps every wrapped row, because the row count is what clearing costs", () => {
  const box = composerBox(screenWith([
    "the quick brown fox jumps over the lazy dog the quick",
    "brown fox jumps over the lazy dog the quick brown fox",
    "jumps over the lazy dog",
  ]));
  expect(box!.rows).toHaveLength(3);
  // Rejoined with the space the wrap consumed, which is what makes this a hypothesis and not a
  // reading. Measured on a live pane: neither row carries that space.
  expect(composerText(box!.rows)).toBe(
    "the quick brown fox jumps over the lazy dog the quick brown fox jumps over the lazy dog the quick brown fox jumps over the lazy dog",
  );
});

test("reads Claude's own hint as an empty box holding a suggestion", () => {
  // Verbatim from a live pane after a turn. Strip the escapes and this is indistinguishable from
  // a reader having typed those words, and the mirror would have filled their field with it and
  // then typed it back into the session. Faint is the only thing that says otherwise -- and the
  // suggestion is worth keeping rather than discarding, because Tab is what turns it into text.
  const screen = [
    RULE,
    "\u001b[39m❯\u00a0\u001b[2mstop adding the three suggestions\u001b[0m",
    RULE,
  ].join("\n");
  expect(composerBox(paneShowing(screen)))
    .toEqual({ rows: [""], hint: "stop adding the three suggestions", exact: true });
});

test("keeps text that merely sits under a colour, because only faint means a hint", () => {
  const screen = [RULE, "\u001b[39m❯\u00a0\u001b[1mtyped in bold\u001b[0m", RULE].join("\n");
  expect(composerBox(paneShowing(screen))).toEqual({ rows: ["typed in bold"], hint: null, exact: true });
});

test("takes the last box, not a turn the transcript echoed with the same marker", () => {
  const screen = [
    RULE,
    "❯\u00a0an earlier turn, already sent",
    RULE,
    "  Claude answered it.",
    RULE,
    "❯\u00a0what is being typed now",
    RULE,
  ].join("\n");
  expect(composerBox(paneShowing(screen))).toEqual({ rows: ["what is being typed now"], hint: null, exact: true });
});

test("answers nothing for a screen mid-redraw, which is retryable rather than broken", () => {
  // The composer box genuinely vanishes between frames; measured on a live pane right after a
  // Ctrl+U. Reporting "" here would push an empty composer into the reader's field.
  expect(composerBox({ screen: ["  adprobe  Opus 5", "  ⏵⏵ auto mode on"].join("\n"), cursor: { row: 1, column: 2 } })).toBeNull();
  // A marker with no rule above it is transcript text, not a box.
  expect(composerBox({ screen: ["  output", "❯\u00a0quoted, in a message"].join("\n"), cursor: { row: 1, column: 2 } })).toBeNull();
});

test("recovers the trailing space the capture cannot show, from the cursor's column", () => {
  // tmux pads every captured row to the pane width, so a box holding "abc " and one holding "abc"
  // come back as the same string and `plainText` trims both to "abc". The cursor is the only thing
  // that can tell them apart. Measured on a live pane against a box starting at column 2: "abc"
  // reported column 5, "abc " reported 6, and "abc   " reported 8.
  expect(composerBox(screenWith(["abc"], { row: 0, column: 3 }))!.rows).toEqual(["abc"]);
  expect(composerBox(screenWith(["abc"], { row: 0, column: 4 }))!.rows).toEqual(["abc "]);
  expect(composerBox(screenWith(["abc"], { row: 0, column: 6 }))!.rows).toEqual(["abc   "]);
});

test("calls a reading inexact when the cursor is anywhere but the end of the last row", () => {
  // Everything past the cursor is unknowable: the capture pads with spaces either way, so a box
  // whose cursor sits in the middle may hold trailing whitespace this cannot see, and the rows
  // BELOW the cursor may too.
  expect(composerBox(screenWith(["abcdef"]))!.exact).toBe(true);
  expect(composerBox(screenWith(["abcdef"], { row: 0, column: 3 }))!.exact).toBe(false);
  expect(composerBox(screenWith(["one", "two"]))!.exact).toBe(true);
  expect(composerBox(screenWith(["one", "two"], { row: 0, column: 3 }))!.exact).toBe(false);
  // A box drawn with nothing in it has nothing to be inexact about, suggestion or no suggestion.
  expect(composerBox(screenWith([]))!.exact).toBe(true);
});

test("retypes rather than edits when the reading is only a lower bound", () => {
  // An append would land after whitespace nobody can see, and a backspace count taken from the
  // visible text would rub out one character too few. Ctrl+U needs neither: it kills a whole
  // visual row whatever is in it, and the row COUNT is exact even when the text is not.
  const inexact = { rows: ["hello"], hint: null, exact: false };
  expect(keystrokesFor(inexact, "hello world"))
    .toBe(`${END}${KILL}${OPEN}hello world${CLOSE}`);
  // Including when the box already reads the way it is being asked to: what it reads is not all
  // it holds, so "nothing to do" would leave the invisible tail in place.
  expect(keystrokesFor(inexact, "hello")).toBe(`${END}${KILL}${OPEN}hello${CLOSE}`);
});

test("does not insert a space that is already in the box", () => {
  // The whole point of reading the cursor. A reader typing "hello world" pauses after the space,
  // which pushes "hello " and leaves the box holding it; the capture says "hello", so the next
  // push appends " world" onto a box that already ends in a space. Measured on a live pane before
  // the cursor was read: the box came back holding "hello  world".
  const held = composerBox(screenWith(["hello"], { row: 0, column: 6 }))!;
  expect(composerText(held.rows)).toBe("hello ");
  expect(keystrokesFor(held, "hello world")).toBe(`${END}${OPEN}world${CLOSE}`);
});

test("stops at the bottom rule rather than swallowing the status lines", () => {
  expect(composerBox(screenWith(["hello"]))).toEqual({ rows: ["hello"], hint: null, exact: true });
});

test("sends nothing when the box already reads that way", () => {
  expect(keystrokesFor(held(["already there"]), "already there")).toBe("");
});

test("appends what was typed, so one keystroke costs one keystroke", () => {
  expect(keystrokesFor(held(["make the hover ring"]), "make the hover rings"))
    .toBe(`${END}${OPEN}s${CLOSE}`);
  // Including from empty, where there is no prefix to match on.
  expect(keystrokesFor(held([""]), "m")).toBe(`${END}${OPEN}m${CLOSE}`);
  // A trailing space is not in the reading -- `capture-pane` strips it -- so the next letter
  // carries it back in. That is why the append is a slice of the DRAFT rather than the character
  // that was typed: sending only "r" here would have closed up a gap the reader had put there.
  expect(keystrokesFor(held(["make the hover"]), "make the hover r"))
    .toBe(`${END}${OPEN} r${CLOSE}`);
});

test("appends onto a wrapped composer when the reconstruction holds", () => {
  // The hypothesis was right, so a long prompt keeps costing one keystroke per keystroke instead
  // of being retyped from scratch on every letter.
  expect(keystrokesFor(held(["alpha bravo", "charlie"]), "alpha bravo charlie delta"))
    .toBe(`${END}${OPEN} delta${CLOSE}`);
});

test("rubs out only what diverged on a row it knows exactly", () => {
  expect(keystrokesFor(held(["hello world"]), "hello there"))
    .toBe(`${END}${BACKSPACE.repeat(5)}${OPEN}there${CLOSE}`);
  // A pure deletion sends no paste at all.
  expect(keystrokesFor(held(["hello world"]), "hello")).toBe(END + BACKSPACE.repeat(6));
});

test("counts a backspace per code point, not per UTF-16 unit", () => {
  expect(keystrokesFor(held(["hi 🐈"]), "hi ")).toBe(END + BACKSPACE);
});

test("clears by row count and retypes when the reconstruction was wrong", () => {
  // Two rows, and what is wanted does not start with the guess -- so the guess is abandoned rather
  // than trusted. Three kills would be wrong; two is what the screen said.
  expect(keystrokesFor(held(["alpha bravo", "charlie"]), "something else entirely"))
    .toBe(`${END}${KILL.repeat(2)}${OPEN}something else entirely${CLOSE}`);
});

test("renders an escape visibly so a draft cannot smuggle a control sequence into the pane", () => {
  expect(keystrokesFor(held([""]), "\u001b[31mred")).toBe(`${END}${OPEN}\u241b[31mred${CLOSE}`);
});

function runtime(overrides: Partial<TmuxComposerRuntime> = {}): TmuxComposerRuntime & {
  sent: string[];
  resolved: number;
} {
  const sent: string[] = [];
  const counted = { resolved: 0 };
  return {
    sent,
    get resolved() {
      return counted.resolved;
    },
    pane: async () => {
      counted.resolved += 1;
      return "agentdesk-1";
    },
    screen: async () => screenWith(["hello"]),
    send: async (_pane, bytes) => {
      sent.push(new TextDecoder().decode(bytes));
    },
    panes: composerPanes(),
    ...overrides,
  };
}

test("reports tmux itself being gone as its own reason, rather than as an empty composer", async () => {
  const tmux = runtime({
    screen: async () => { throw new TmuxUnavailable("no server running"); },
  });
  expect(await readComposerAt("agentdesk-1", tmux))
    .toEqual({ text: null, hint: null, reason: "tmux-unavailable", wrapped: false });
});

test("marks a multi-row reading as wrapped, so the panel knows not to trust it exactly", async () => {
  const tmux = runtime({ screen: async () => screenWith(["alpha bravo", "charlie"]) });
  expect(await readComposerAt("agentdesk-1", tmux))
    .toEqual({ text: "alpha bravo charlie", hint: null, reason: null, wrapped: true });
});

test("re-reads the screen before every push, rather than trusting the caller's view of it", async () => {
  // A pane that answers with whatever it currently holds, and takes what is sent to it. A queue of
  // canned screens would not do here: a push reads the box, and then reads it again to watch the
  // send arrive, so what the second push sees has to be a consequence of the first.
  let held = "hel";
  const tmux = runtime({
    screen: async () => screenWith([held]),
    send: async (_pane, bytes) => {
      const keys = new TextDecoder().decode(bytes);
      tmux.sent.push(keys);
      held += typed(keys);
    },
  });
  await syncTmuxComposer("session", "hello", tmux);
  // The pane had "hel" at that instant, so only "lo" is typed -- even though the panel's own last
  // observation would have said otherwise.
  expect(tmux.sent).toEqual([`${END}${OPEN}lo${CLOSE}`]);
  await syncTmuxComposer("session", "hello", tmux);
  // Second time the pane already agrees, so nothing is sent at all.
  expect(tmux.sent).toHaveLength(1);
});

test("a push into a session with no pane sends nothing, and never reaches for a screen", async () => {
  let asked = false;
  const tmux = runtime({
    pane: async () => null,
    screen: async () => {
      asked = true;
      return screenWith([]);
    },
  });
  expect(await syncTmuxComposer("session", "hello", tmux))
    .toEqual({ text: null, hint: null, reason: "no-pane", wrapped: false });
  expect(tmux.sent).toEqual([]);
  expect(asked).toBe(false);
});

test("accepting the hint presses Tab, and guesses nothing about what lands", async () => {
  // Measured on a live pane: after a Tab the same row comes back with no faint run at all, which
  // is Claude turning its own suggestion into text. What the box then holds is the watcher's to
  // report, so `text` is null here rather than a copy of the hint.
  const tmux = runtime({
    screen: async () => { throw new Error("accepting must not read the screen"); },
  });
  expect(await acceptTmuxComposerHint("session", tmux))
    .toEqual({ text: null, hint: null, reason: null, wrapped: false });
  expect(tmux.sent).toEqual(["\t"]);
});

test("submitting presses Return, and needs no screen to do it", async () => {
  const tmux = runtime({
    screen: async () => { throw new Error("submit must not read the screen"); },
  });
  expect(await submitTmuxComposer("session", tmux))
    .toEqual({ text: "", hint: null, reason: null, wrapped: false });
  expect(tmux.sent).toEqual(["\r"]);
});

/** A pane that can be told to write, so the watcher can be driven without a tmux server. */
function watchable(initial: string[] = ["hello"]) {
  let notify: (() => void) | null = null;
  const state = {
    rows: initial,
    pane: "agentdesk-1" as string | null,
    /** How many times the screen was captured, which is the cost this change exists to remove. */
    screens: 0,
    /** How many times the pane was gone looking for, which is the expensive one. */
    resolved: 0,
    sent: [] as string[],
    watching: false,
  };
  const tmux: TmuxComposerWatchRuntime = {
    pane: async () => {
      state.resolved += 1;
      return state.pane;
    },
    screen: async () => {
      state.screens += 1;
      return screenWith(state.rows);
    },
    send: async (_pane, bytes) => {
      state.sent.push(new TextDecoder().decode(bytes));
    },
    panes: composerPanes(),
    watch: async (_pane, onOutput) => {
      state.watching = true;
      notify = onOutput;
      return () => {
        state.watching = false;
        notify = null;
      };
    },
  };
  return { state, tmux, write: () => notify?.() };
}

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("reports what the composer holds without waiting for the pane to write", async () => {
  // An idle pane writes nothing at all, so a watcher that only ever spoke on output would say
  // nothing until somebody typed -- and the field would sit empty beside a box that was not.
  const { tmux, state } = watchable(["make the hover ring stronger"]);
  const seen: unknown[] = [];
  const stop = observeTmuxComposer("session", {
    onState: (reading) => { seen.push(reading); },
    onEnd: () => {},
  }, tmux);
  await settle(60);
  expect(seen).toEqual([{ text: "make the hover ring stronger", hint: null, reason: null, wrapped: false }]);
  expect(state.watching).toBe(true);
  stop();
  expect(state.watching).toBe(false);
});

test("reads once for a burst of output, not once per write", async () => {
  const { tmux, state, write } = watchable([""]);
  const stop = observeTmuxComposer("session", { onState: () => {}, onEnd: () => {} }, tmux);
  await settle(60);
  const before = state.screens;
  for (let i = 0; i < 20; i += 1) write();
  await settle(300);
  // One redraw is many writes. Reading per write would read twenty times for one change, and
  // most of those captures would land mid-redraw, where the box is not on the screen at all.
  expect(state.screens - before).toBe(1);
  stop();
});

test("reports only what changed, so a redraw above the box costs nobody anything", async () => {
  const { tmux, state, write } = watchable(["hello"]);
  const seen: unknown[] = [];
  const stop = observeTmuxComposer("session", {
    onState: (reading) => { seen.push(reading); },
    onEnd: () => {},
  }, tmux);
  await settle(60);
  expect(seen).toHaveLength(1);

  // The session is working: it writes constantly, and its composer does not move.
  write();
  await settle(300);
  write();
  await settle(300);
  expect(state.screens).toBeGreaterThan(1);
  expect(seen).toHaveLength(1);

  // Now somebody types into the pane itself.
  state.rows = ["hello there"];
  write();
  await settle(300);
  expect(seen).toEqual([
    { text: "hello", hint: null, reason: null, wrapped: false },
    { text: "hello there", hint: null, reason: null, wrapped: false },
  ]);
  stop();
});

test("says a session has no pane, ends, and hangs no pipe on nothing", async () => {
  // Ends rather than waiting. There is nothing to watch, and a session gains a pane often enough
  // to matter -- the band's own terminal button resumes one -- so the retry belongs to whoever
  // asked. A stream that stayed open would need a timer to notice, which is what this replaced.
  const { tmux, state } = watchable();
  state.pane = null;
  const seen: unknown[] = [];
  let ended = 0;
  const stop = observeTmuxComposer("session", {
    onState: (reading) => { seen.push(reading); },
    onEnd: () => { ended += 1; },
  }, tmux);
  await settle(60);
  expect(seen).toEqual([{ text: null, hint: null, reason: "no-pane", wrapped: false }]);
  expect(ended).toBe(1);
  expect(state.watching).toBe(false);
  expect(state.screens).toBe(0);
  stop();
});

test("a watched pane is never ended out from under its reader", async () => {
  const { tmux, write } = watchable(["hello"]);
  let ended = 0;
  const stop = observeTmuxComposer("session", {
    onState: () => {},
    onEnd: () => { ended += 1; },
  }, tmux);
  await settle(60);
  write();
  await settle(300);
  expect(ended).toBe(0);
  stop();
});

test("stopping before the pane answers still leaves nothing watching", async () => {
  // The resolve and the watch are both awaited, so a reader that leaves in between would
  // otherwise have a pipe set on its behalf with nobody left to close it.
  const { tmux, state } = watchable();
  const stop = observeTmuxComposer("session", { onState: () => {}, onEnd: () => {} }, tmux);
  stop();
  await settle(60);
  expect(state.watching).toBe(false);
});

test("a push takes the pane the watch is already on, instead of going to find it again", async () => {
  // The point of the whole registry. Resolving reads every session record on disk and asks the
  // kernel about each pid, so a debounced push per keystroke burst was paying about fifty
  // milliseconds to be told what the open watch had known since it opened.
  const { tmux, state } = watchable(["hel"]);
  const stop = observeTmuxComposer("session", { onState: () => {}, onEnd: () => {} }, tmux);
  await settle(60);
  expect(state.resolved).toBe(1);

  await syncTmuxComposer("session", "hello", tmux);
  await submitTmuxComposer("session", tmux);
  expect(state.resolved).toBe(1);
  expect(state.sent).toEqual([`${END}${OPEN}lo${CLOSE}`, "\r"]);
  stop();
});

test("a push with nobody watching goes and finds the pane for itself", async () => {
  // The gap between a dropped stream and `EventSource` coming back is real, and typing during it
  // has to reach the pane. A miss resolves; it does not refuse.
  const tmux = runtime({ screen: async () => screenWith([""]) });
  await syncTmuxComposer("session", "hello", tmux);
  expect(tmux.resolved).toBe(1);
  expect(tmux.sent).toEqual([`${END}${OPEN}hello${CLOSE}`]);
});

test("a watch that let go stops lending its pane", async () => {
  const { tmux, state } = watchable([""]);
  const stop = observeTmuxComposer("session", { onState: () => {}, onEnd: () => {} }, tmux);
  await settle(60);
  stop();
  await syncTmuxComposer("session", "hello", tmux);
  expect(state.resolved).toBe(2);
});

test("a pane that stops answering is dropped, so the next push says the session is gone", async () => {
  // Where a session that ended is found out, now that no push resolves by reflex. tmux takes the
  // session down with the process, so the first push after that fails truthfully and forgets the
  // pane, and the one after it resolves, finds nothing running, and says so.
  const panes = composerPanes();
  panes.hold("session", "agentdesk-1");
  const tmux = runtime({
    panes,
    pane: async () => null,
    screen: async () => { throw new TmuxUnavailable("can't find session"); },
  });
  expect(await syncTmuxComposer("session", "hello", tmux))
    .toEqual({ text: null, hint: null, reason: "tmux-unavailable", wrapped: false });
  expect(await syncTmuxComposer("session", "hello", tmux))
    .toEqual({ text: null, hint: null, reason: "no-pane", wrapped: false });
});

test("two watchers hold one pane independently, and the first to leave does not take it", async () => {
  const panes = composerPanes();
  const first = panes.hold("session", "agentdesk-1");
  const second = panes.hold("session", "agentdesk-1");
  first();
  expect(panes.get("session")).toBe("agentdesk-1");
  second();
  expect(panes.get("session")).toBeNull();
});

test("a watch that started after a forget still owns its own hold", async () => {
  // The release closure holds the set it added to, which a forget detaches from the map. Deleting
  // by key alone on the way out would drop the NEXT watch's pane.
  const panes = composerPanes();
  const stale = panes.hold("session", "agentdesk-1");
  panes.forget("session");
  const fresh = panes.hold("session", "agentdesk-2");
  stale();
  expect(panes.get("session")).toBe("agentdesk-2");
  fresh();
  expect(panes.get("session")).toBeNull();
});

test("a dropped image is pasted as its path alone, which is what a terminal drop sends", async () => {
  // Measured in the CLI: the paste handler reads the text of THIS paste to decide whether it is
  // looking at a file path, so the path cannot ride along with anything else.
  const tmux = runtime({ screen: async () => screenWith([""]) });
  expect(await dropTmuxComposerImage("session", "/tmp/a-b/c.png", tmux))
    .toEqual({ text: null, hint: null, reason: null, wrapped: false });
  expect(tmux.sent).toEqual([`${OPEN}/tmp/a-b/c.png${CLOSE}`]);
});

test("separates the path from text already in the box, with a space outside the paste", async () => {
  // Measured: a paste of " /tmp/x.png" splits on the space that precedes the slash and the empty
  // half is filtered away, so a space put INSIDE the paste never reaches the box.
  const tmux = runtime({ screen: async () => screenWith(["look at this"]) });
  await dropTmuxComposerImage("session", "/tmp/x.png", tmux);
  expect(tmux.sent).toEqual([` ${OPEN}/tmp/x.png${CLOSE}`]);
});

test("a drop into a session with no pane pastes nothing and says why", async () => {
  const tmux = runtime({ panes: composerPanes(), pane: async () => null });
  expect(await dropTmuxComposerImage("session", "/tmp/x.png", tmux))
    .toEqual({ text: null, hint: null, reason: "no-pane", wrapped: false });
  expect(tmux.sent).toEqual([]);
});

test("renames by pasting Claude's own command into an empty composer, with the Return", async () => {
  // One send, so nothing can be typed between the command and the Return into the box that was
  // just checked empty. Pasted rather than typed: measured that Claude dispatches a slash command
  // that arrives as a bracketed paste, which is also how it avoids the menu a typed `/` opens.
  const tmux = runtime({ screen: async () => screenWith([""]) });

  expect(await renameTmuxSession("s1", "What I called it", tmux)).toEqual({ renamed: true });
  expect(tmux.sent).toEqual([`${END}${OPEN}/rename What I called it${CLOSE}\r`]);
});

test("refuses to rename over text somebody is in the middle of writing", async () => {
  // The only way to type a command into a box is to type it where the reader was writing.
  const tmux = runtime({ screen: async () => screenWith(["half a thought"]) });

  expect(await renameTmuxSession("s1", "New name", tmux))
    .toEqual({ renamed: false, reason: "composer-busy" });
  expect(tmux.sent).toEqual([]);
});

test("refuses to rename a session with no pane to ask", async () => {
  // There is deliberately no fallback to writing the transcript: that moves the title and leaves
  // the address behind, which is the half rename this mechanism exists to avoid.
  const tmux = runtime({ pane: async () => null, screen: async () => screenWith([""]) });

  expect(await renameTmuxSession("s1", "New name", tmux))
    .toEqual({ renamed: false, reason: "no-pane" });
  expect(tmux.sent).toEqual([]);
});

test("reports tmux being gone as its own reason rather than as a busy composer", async () => {
  const tmux = runtime({
    screen: async () => { throw new TmuxUnavailable("no server running"); },
  });

  expect(await renameTmuxSession("s1", "New name", tmux))
    .toEqual({ renamed: false, reason: "tmux-unavailable" });
});

test("rubs out an attachment token with ONE backspace, because that is what the box does", () => {
  // Measured on a live pane: with `[Image #2] omega` in the box, six presses took " omega" one
  // character at a time and the seventh took the whole token. Counting its characters instead
  // would have sent eleven presses and deleted four characters of whatever sat to its left.
  expect(keystrokesFor(held(["alpha [Image #2] omega"]), "alpha "))
    .toBe(END + BACKSPACE.repeat(7));
  // Twenty-six characters, one press, same as the image.
  expect(keystrokesFor(held(["[Pasted text #3 +38 lines] tail"]), ""))
    .toBe(END + BACKSPACE.repeat(6));
});

test("never splits a token, since half of one cannot be deleted", () => {
  // The shared prefix ends inside `[Image #12]` here. Counting from there would rub out the rest
  // of the token by character and then meet a token that goes whole, taking the neighbours too.
  // Backed up to the token's start, so it is six presses for " after" and one for the token,
  // then the whole tail is retyped.
  expect(keystrokesFor(held(["before [Image #12] after"]), "before [Image #1] after"))
    .toBe(`${END}${BACKSPACE.repeat(7)}${OPEN}[Image #1] after${CLOSE}`);
});

test("takes a token out of the middle without touching what sits either side", () => {
  // What removing an image from the panel's strip comes to: the token goes and the text does not.
  expect(keystrokesFor(held(["alpha [Image #2] omega"]), "alpha omega"))
    .toBe(`${END}${BACKSPACE.repeat(7)}${OPEN}omega${CLOSE}`);
});

test("two pushes at one session do not read the same box and both paste their whole text", async () => {
  // The reader's bug, in the shape it actually happened. The panel debounces at 90ms and a push
  // over a slow link takes longer than that, so a second push starts while the first is still out.
  // Measured against a live pane before this was serialised: "hello wor" and "hello world now"
  // fired together left the box holding `hello world nowhello wor`, and both requests answered
  // 200. Here the pane is slow in the same two places a real one is.
  let held = "";
  const tmux = runtime({
    screen: async () => {
      await new Promise((wake) => setTimeout(wake, 5));
      return screenWith([held]);
    },
    send: async (_pane, bytes) => {
      const keys = new TextDecoder().decode(bytes);
      tmux.sent.push(keys);
      await new Promise((wake) => setTimeout(wake, 5));
      held += typed(keys);
    },
  });

  await Promise.all([
    syncTmuxComposer("session", "hello wor", tmux),
    syncTmuxComposer("session", "hello world now", tmux),
  ]);

  // Whichever ran second appended only what it was missing, because it read a box the first had
  // already finished writing to.
  expect(held).toBe("hello world now");
  expect(tmux.sent).toEqual([`${END}${OPEN}hello wor${CLOSE}`, `${END}${OPEN}ld now${CLOSE}`]);
});

test("a push waits for its send to reach the screen, so the next one reads the box and not its past", async () => {
  // Claude redraws 21-46ms after `send-keys` returns (measured, ten trials). A push that returned
  // inside that window would hand the next one a screen showing the moment before its own send.
  let held = "";
  let reads = 0;
  const tmux = runtime({
    screen: async () => {
      reads += 1;
      return screenWith([held]);
    },
    send: async (_pane, bytes) => {
      const keys = new TextDecoder().decode(bytes);
      tmux.sent.push(keys);
      // Late, the way a pane is: the send returns before the screen carries it.
      setTimeout(() => { held += typed(keys); }, 20);
    },
  });

  await syncTmuxComposer("session", "alpha", tmux);
  // It did not return on the strength of the send alone: the screen now carries it.
  expect(held).toBe("alpha");
  expect(reads).toBeGreaterThan(1);
});

test("a send that never shows up on screen gives the push back rather than holding it forever", async () => {
  // The pane belongs to whoever is sitting at it, and they may have typed something that makes the
  // reading never match. Waiting is worth a moment and is not worth a request.
  const tmux = runtime({ screen: async () => screenWith(["frozen"]) });
  const started = Date.now();
  expect(await syncTmuxComposer("session", "something else", tmux))
    .toEqual({ text: "something else", hint: null, reason: null, wrapped: false });
  expect(Date.now() - started).toBeLessThan(2_000);
});

test("a failed turn does not take the next one down with it", async () => {
  // The chain the next caller waits on must never carry a rejection, or one unreachable pane would
  // fail every push queued behind it on that session.
  let first = true;
  const tmux = runtime({
    screen: async () => {
      if (first) {
        first = false;
        throw new TmuxUnavailable("no server running");
      }
      return screenWith([""]);
    },
  });
  const [broken, fine] = await Promise.all([
    syncTmuxComposer("shared", "one", tmux),
    syncTmuxComposer("shared", "two", tmux),
  ]);
  expect(broken.reason).toBe("tmux-unavailable");
  expect(fine).toEqual({ text: "two", hint: null, reason: null, wrapped: false });
});

test("a push that landed is not reported as failed because the pane stopped answering afterwards", async () => {
  // The wait happens after the send, so tmux going away during it says nothing about whether the
  // text arrived. Reporting that as an unavailable session would also drop the held pane, making
  // the next push pay a full resolution for a push that had already worked.
  let sends = 0;
  const tmux = runtime({
    screen: async () => {
      if (sends > 0) throw new TmuxUnavailable("no server running");
      return screenWith([""]);
    },
    send: async (_pane, bytes) => {
      sends += 1;
      tmux.sent.push(new TextDecoder().decode(bytes));
    },
  });
  expect(await syncTmuxComposer("session", "alpha", tmux))
    .toEqual({ text: "alpha", hint: null, reason: null, wrapped: false });
  expect(tmux.sent).toEqual([`${END}${OPEN}alpha${CLOSE}`]);
});

test("the turn a session is taking outlives a reload of this module", async () => {
  // `bun --watch` re-reads a changed module in process, so anything held in a module-level `const`
  // is thrown away while the requests already running keep going. Serialisation kept there would
  // stop serialising the moment somebody edits this file, which is when it is needed most.
  const store = Symbol.for("agentdesk.composerTurns");
  const held = (globalThis as Record<symbol, unknown>)[store];
  expect(held).toBeInstanceOf(Map);

  // And a fresh evaluation of this module finds the same one rather than starting its own.
  const reloaded = await import(`./tmuxComposer.ts?reloaded=${Date.now()}`);
  const tmux = runtime({ screen: async () => screenWith([""]) });
  await reloaded.syncTmuxComposer("reload-probe", "alpha", tmux);
  expect((globalThis as Record<symbol, unknown>)[store]).toBe(held);
});

test("goes to the end before editing, because a backspace bites wherever the cursor is", () => {
  // The assumption every branch here is written on is that the text ends at the cursor. Nothing
  // made that true. A reader on a phone breaks it by tapping in the middle of their own sentence,
  // and the arrows on the key rail break it deliberately.
  //
  // Measured on a live pane: a box reading `abXcdef` with the cursor after the X, pushed `abcdef`,
  // answered 200 and left `cdefcdef` -- five backspaces ate `abX` and stopped at the start, and
  // the paste landed at position zero instead of after `ab`. The reader sees their words twice.
  //
  // The key is Ctrl+E rather than End, measured against tmux's own cursor report: End is
  // end-of-VISUAL-LINE, so on a wrapped box it leaves the cursor at the wrap boundary and the
  // row-count clear below then spares every row under it. See `END` in the module.
  for (const [rows, desired] of [
    [[""], "typed from nothing"],
    [["hello"], "hello world"],
    [["hello world"], "hello there"],
    [["one", "two"], "something else"],
  ] as const) {
    expect(keystrokesFor(held([...rows]), desired).startsWith(END)).toBe(true);
  }
  // Nothing to do stays nothing to do: a box that already agrees is not worth a cursor move.
  expect(keystrokesFor(held(["settled"]), "settled")).toBe("");
  // Named rather than merely asserted through the constant, because the constant is the thing that
  // was wrong: a change back to either End would satisfy every line above it and reinstate the
  // defect. The comparison cannot be made against a pane in this suite -- telling end-of-line from
  // end-of-buffer needs a real cursor -- so it is made against the two sequences measured to be
  // end-of-line, which is the part a fake cannot lie about.
  expect(END).toBe("\u0005");
  for (const endOfLine of ["\u001b[F", "\u001bOF"]) {
    expect(keystrokesFor(held(["one", "two"]), "something else").startsWith(endOfLine)).toBe(false);
  }
});
