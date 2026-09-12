import { expect, test } from "bun:test";
import {
  composerRows,
  composerText,
  keystrokesFor,
  observeTmuxComposer,
  readTmuxComposer,
  submitTmuxComposer,
  syncTmuxComposer,
  type TmuxComposerRuntime,
  type TmuxComposerWatchRuntime,
} from "./tmuxComposer.ts";
import { TmuxUnavailable } from "../terminal/tmuxSessions.ts";

const RULE = "─".repeat(60);

/** A screen as `capture-pane` returns one, with the composer holding `rows`. */
function screenWith(rows: string[]): string {
  return [
    "  Some earlier output from the session.",
    "",
    RULE,
    // A no-break space after the marker, which is what a live pane actually writes.
    `❯\u00a0${rows[0] ?? ""}`,
    ...rows.slice(1).map((row) => `  ${row}`),
    RULE,
    "  adprobe  Opus 5 (1M context)                    0 tokens",
    "  ⏵⏵ auto mode on (shift+tab to cycle)                 /rc",
  ].join("\n");
}

const KILL = "\u0015";
const BACKSPACE = "\u007f";
const OPEN = "\u001b[200~";
const CLOSE = "\u001b[201~";

test("reads the composer box, and an empty one as empty rather than as absent", () => {
  expect(composerRows(screenWith(["make the hover ring stronger"])))
    .toEqual(["make the hover ring stronger"]);
  // The distinction the whole reconciliation rests on: "" is adopted into the field, null is not.
  expect(composerRows(screenWith([]))).toEqual([""]);
});

test("keeps every wrapped row, because the row count is what clearing costs", () => {
  const rows = composerRows(screenWith([
    "the quick brown fox jumps over the lazy dog the quick",
    "brown fox jumps over the lazy dog the quick brown fox",
    "jumps over the lazy dog",
  ]));
  expect(rows).toHaveLength(3);
  // Rejoined with the space the wrap consumed, which is what makes this a hypothesis and not a
  // reading. Measured on a live pane: neither row carries that space.
  expect(composerText(rows!)).toBe(
    "the quick brown fox jumps over the lazy dog the quick brown fox jumps over the lazy dog the quick brown fox jumps over the lazy dog",
  );
});

test("reads Claude's own hint as an empty box, not as somebody's text", () => {
  // Verbatim from a live pane after a turn. Strip the escapes and this is indistinguishable from
  // a reader having typed those words, and the mirror would have filled their field with it and
  // then typed it back into the session. Faint is the only thing that says otherwise.
  const screen = [
    RULE,
    "\u001b[39m❯\u00a0\u001b[2m<no suggestion>\u001b[0m",
    RULE,
  ].join("\n");
  expect(composerRows(screen)).toEqual([""]);
});

test("keeps text that merely sits under a colour, because only faint means a hint", () => {
  const screen = [RULE, "\u001b[39m❯\u00a0\u001b[1mtyped in bold\u001b[0m", RULE].join("\n");
  expect(composerRows(screen)).toEqual(["typed in bold"]);
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
  expect(composerRows(screen)).toEqual(["what is being typed now"]);
});

test("answers nothing for a screen mid-redraw, which is retryable rather than broken", () => {
  // The composer box genuinely vanishes between frames; measured on a live pane right after a
  // Ctrl+U. Reporting "" here would push an empty composer into the reader's field.
  expect(composerRows(["  adprobe  Opus 5", "  ⏵⏵ auto mode on"].join("\n"))).toBeNull();
  // A marker with no rule above it is transcript text, not a box.
  expect(composerRows(["  output", "❯\u00a0quoted, in a message"].join("\n"))).toBeNull();
});

test("stops at the bottom rule rather than swallowing the status lines", () => {
  expect(composerRows(screenWith(["hello"]))).toEqual(["hello"]);
});

test("sends nothing when the box already reads that way", () => {
  expect(keystrokesFor(["already there"], "already there")).toBe("");
});

test("appends what was typed, so one keystroke costs one keystroke", () => {
  expect(keystrokesFor(["make the hover ring"], "make the hover rings"))
    .toBe(`${OPEN}s${CLOSE}`);
  // Including from empty, where there is no prefix to match on.
  expect(keystrokesFor([""], "m")).toBe(`${OPEN}m${CLOSE}`);
  // A trailing space is not in the reading -- `capture-pane` strips it -- so the next letter
  // carries it back in. That is why the append is a slice of the DRAFT rather than the character
  // that was typed: sending only "r" here would have closed up a gap the reader had put there.
  expect(keystrokesFor(["make the hover"], "make the hover r"))
    .toBe(`${OPEN} r${CLOSE}`);
});

test("appends onto a wrapped composer when the reconstruction holds", () => {
  // The hypothesis was right, so a long prompt keeps costing one keystroke per keystroke instead
  // of being retyped from scratch on every letter.
  expect(keystrokesFor(["alpha bravo", "charlie"], "alpha bravo charlie delta"))
    .toBe(`${OPEN} delta${CLOSE}`);
});

test("rubs out only what diverged on a row it knows exactly", () => {
  expect(keystrokesFor(["hello world"], "hello there"))
    .toBe(`${BACKSPACE.repeat(5)}${OPEN}there${CLOSE}`);
  // A pure deletion sends no paste at all.
  expect(keystrokesFor(["hello world"], "hello")).toBe(BACKSPACE.repeat(6));
});

test("counts a backspace per code point, not per UTF-16 unit", () => {
  expect(keystrokesFor(["hi 🐈"], "hi ")).toBe(BACKSPACE);
});

test("clears by row count and retypes when the reconstruction was wrong", () => {
  // Two rows, and what is wanted does not start with the guess -- so the guess is abandoned rather
  // than trusted. Three kills would be wrong; two is what the screen said.
  expect(keystrokesFor(["alpha bravo", "charlie"], "something else entirely"))
    .toBe(`${KILL.repeat(2)}${OPEN}something else entirely${CLOSE}`);
});

test("renders an escape visibly so a draft cannot smuggle a control sequence into the pane", () => {
  expect(keystrokesFor([""], "\u001b[31mred")).toBe(`${OPEN}\u241b[31mred${CLOSE}`);
});

function runtime(overrides: Partial<TmuxComposerRuntime> = {}): TmuxComposerRuntime & {
  sent: string[];
} {
  const sent: string[] = [];
  return {
    sent,
    pane: async () => "agentdesk-1",
    screen: async () => screenWith(["hello"]),
    send: async (_pane, bytes) => {
      sent.push(new TextDecoder().decode(bytes));
    },
    ...overrides,
  };
}

test("reports a session that is not running in tmux, without reaching for a screen", async () => {
  let asked = false;
  const tmux = runtime({
    pane: async () => null,
    screen: async () => {
      asked = true;
      return "";
    },
  });
  expect(await readTmuxComposer("session", tmux))
    .toEqual({ text: null, reason: "no-pane", wrapped: false });
  expect(asked).toBe(false);
});

test("reports tmux itself being gone as its own reason, rather than as an empty composer", async () => {
  const tmux = runtime({
    screen: async () => { throw new TmuxUnavailable("no server running"); },
  });
  expect(await readTmuxComposer("session", tmux))
    .toEqual({ text: null, reason: "tmux-unavailable", wrapped: false });
});

test("marks a multi-row reading as wrapped, so the panel knows not to trust it exactly", async () => {
  const tmux = runtime({ screen: async () => screenWith(["alpha bravo", "charlie"]) });
  expect(await readTmuxComposer("session", tmux))
    .toEqual({ text: "alpha bravo charlie", reason: null, wrapped: true });
});

test("re-reads the screen before every push, rather than trusting the caller's view of it", async () => {
  const screens = [screenWith(["hel"]), screenWith(["hello"])];
  const tmux = runtime({ screen: async () => screens.shift() ?? screenWith([""]) });
  await syncTmuxComposer("session", "hello", tmux);
  // The pane had "hel" at that instant, so only "lo" is typed -- even though the panel's own last
  // observation would have said otherwise.
  expect(tmux.sent).toEqual([`${OPEN}lo${CLOSE}`]);
  await syncTmuxComposer("session", "hello", tmux);
  // Second time the pane already agrees, so nothing is sent at all.
  expect(tmux.sent).toHaveLength(1);
});

test("a push into a session with no pane sends nothing and says why", async () => {
  const tmux = runtime({ pane: async () => null });
  expect(await syncTmuxComposer("session", "hello", tmux))
    .toEqual({ text: null, reason: "no-pane", wrapped: false });
  expect(tmux.sent).toEqual([]);
});

test("submitting presses Return, and needs no screen to do it", async () => {
  const tmux = runtime({
    screen: async () => { throw new Error("submit must not read the screen"); },
  });
  expect(await submitTmuxComposer("session", tmux))
    .toEqual({ text: "", reason: null, wrapped: false });
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
    watching: false,
  };
  const tmux: TmuxComposerWatchRuntime = {
    pane: async () => state.pane,
    screen: async () => {
      state.screens += 1;
      return screenWith(state.rows);
    },
    send: async () => {},
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
  expect(seen).toEqual([{ text: "make the hover ring stronger", reason: null, wrapped: false }]);
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
    { text: "hello", reason: null, wrapped: false },
    { text: "hello there", reason: null, wrapped: false },
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
  expect(seen).toEqual([{ text: null, reason: "no-pane", wrapped: false }]);
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
