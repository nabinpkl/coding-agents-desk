import { expect, test } from "bun:test";
import {
  composerRows,
  composerText,
  keystrokesFor,
  readTmuxComposer,
  submitTmuxComposer,
  syncTmuxComposer,
  type TmuxComposerRuntime,
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
