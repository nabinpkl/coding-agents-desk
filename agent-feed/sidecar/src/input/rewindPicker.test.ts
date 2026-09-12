// The screens here are transcriptions of real captures taken from Claude Code 2.1.266 in a 120x40
// tmux pane on 2026-09-09, not invented shapes. That matters more than usual: this module's whole
// job is agreeing with a renderer nobody here controls, so a fixture written from the parser's own
// assumptions would agree with the parser and prove nothing.
//
// What is deliberately NOT asserted is the colour. The live picker paints the selected row bold
// `38;5;153`, and the parser reads the marker instead, so the fixtures carry the marker and leave
// the escapes out. If the marker ever goes away, colour is the fallback these would be rewritten
// against.

import { expect, test } from "bun:test";
import { bytesForRailKey } from "@agentdesk/agent-feed-wire";
import type { TmuxPaneView } from "../terminal/tmuxSessions.ts";
import {
  MAX_REWIND_STEPS,
  rewindScreen,
  rewindTmuxSession,
  saysTheSame,
  type RewindRuntime,
} from "./rewindPicker.ts";

const PANE = "agentdesk-fork-1";
const SESSION = "77777777-7777-4777-8777-777777777777";

/** The gap Claude writes after its marker, which is not an ordinary space. */
const NBSP = "\u00a0";
const UP = bytesForRailKey("up");
const DOWN = bytesForRailKey("down");
const ESCAPE = bytesForRailKey("escape");
const CARRIAGE_RETURN = "\r";
const RULE = "─".repeat(120);

/**
 * The picker as it opens: every message oldest first, then `(current)` with the selection on it.
 *
 * `selected` counts from the end the way the driver does -- 0 is `(current)`, 1 is the newest
 * message -- so a fixture reads the way the thing it is standing in for is addressed.
 */
function picker(messages: readonly string[], selected: number): string {
  const rows = [RULE, "  Rewind", "", "  Restore the code and/or conversation to the point before…", ""];
  messages.forEach((text, index) => {
    const fromEnd = messages.length - index;
    rows.push(`${fromEnd === selected ? `  ❯${NBSP}` : "    "}${text}`);
    rows.push("    ⚠ No code restore");
    rows.push("");
  });
  rows.push(`${selected === 0 ? `  ❯${NBSP}` : "    "}(current)`);
  rows.push("", "", "  Enter to continue · Esc to cancel", `${RULE} Rewind probe ─`);
  return rows.join("\n");
}

/** The second menu, whose options depend on what the chosen turn touched. */
function confirm(options: readonly string[], selected: number): string {
  const rows = [
    "  │ CHARLIE three. Reply with just OK.",
    "  │ (1m ago)",
    "",
    "  The conversation will be forked.",
    "  The code will be unchanged.",
    "",
  ];
  options.forEach((label, index) => {
    rows.push(`${index === selected ? `  ❯${NBSP}` : "    "}${index + 1}. ${label}`);
  });
  return rows.join("\n");
}

/** An ordinary composer, which is what the pane shows before and after all of this. */
function composer(text = ""): string {
  return [RULE, `❯${NBSP}${text}`, RULE, "  rewindprobe  Haiku 4.5  ctx:18%"].join("\n");
}

function view(screen: string): TmuxPaneView {
  return { screen, cursor: { row: 1, column: 2 } };
}

/**
 * A pane that behaves the way the measured one does, rather than replaying a list of screens.
 *
 * A fixed sequence was the first shape of this and it was wrong: the driver reads a variable number
 * of times per step (it polls for a redraw, and reads the composer separately), so a list drifts
 * out of step with it and the test starts asserting the harness. Modelling the transitions instead
 * means the choreography itself -- which key, in which order, and what clamps -- is what is under
 * test.
 *
 * Every transition below is one measured on 2026-09-09: the picker opens on `(current)`, Up walks
 * toward older and CLAMPS at the oldest, Enter opens the confirm menu, and confirming leaves the
 * rewound-to message in the composer.
 */
function pane(options: {
  messages: readonly string[];
  confirmOptions?: readonly string[];
  /** Where the picker opens. 0 is `(current)`, which is where a real one always opens. */
  opensAt?: number;
  /** A pane that ignores `/rewind`, standing in for one that is busy or not Claude at all. */
  deaf?: boolean;
  composerHolds?: string;
}): RewindRuntime & { sent: string[] } {
  const confirmOptions = options.confirmOptions ?? ["Restore conversation", "Never mind"];
  const sent: string[] = [];
  let state: "composer" | "picker" | "confirm" = "composer";
  let selected = options.opensAt ?? 0;
  let option = 0;
  let box = options.composerHolds ?? "";

  /** The message the selection is on, or null on `(current)`. */
  const chosen = (): string | null =>
    selected === 0 ? null : options.messages[options.messages.length - selected] ?? null;

  return {
    sent,
    pane: async () => PANE,
    screen: async () => view(
      state === "picker"
        ? picker(options.messages, selected)
        : state === "confirm"
        ? confirm(confirmOptions, option)
        : composer(box),
    ),
    send: async (_pane: string, bytes: Uint8Array) => {
      const keys = new TextDecoder().decode(bytes);
      sent.push(keys);
      if (keys === ESCAPE) {
        state = "composer";
        return;
      }
      if (state === "composer" && keys.includes("/rewind")) {
        if (options.deaf) return;
        state = "picker";
        selected = options.opensAt ?? 0;
        return;
      }
      if (state === "picker") {
        // Up walks toward the oldest and stops there. Measured: six presses against four positions
        // sat on the first entry rather than wrapping.
        if (keys === UP) selected = Math.min(selected + 1, options.messages.length);
        else if (keys === DOWN) selected = Math.max(selected - 1, 0);
        else if (keys === CARRIAGE_RETURN && selected > 0) {
          state = "confirm";
          option = 0;
        }
        return;
      }
      if (state === "confirm") {
        if (keys === DOWN) option = Math.min(option + 1, confirmOptions.length - 1);
        else if (keys === UP) option = Math.max(option - 1, 0);
        else if (keys === CARRIAGE_RETURN) {
          // Only the conversation restore is modelled as succeeding; nothing else should be pressed.
          if (confirmOptions[option] !== "Restore conversation") throw new Error("wrong option taken");
          state = "composer";
          box = chosen() ?? "";
        }
      }
    },
    // A refusal must not spend the live redraw budget proving itself.
    redrawLimitMs: 0,
    wait: async () => {},
  };
}

const THREE = ["ALPHA one. Reply with just OK.", "BRAVO two. Reply with just OK.", "CHARLIE three."];

test("reads the picker as it opens, with the selection below the newest message", () => {
  const screen = rewindScreen(view(picker(THREE, 0)));

  expect(screen?.kind).toBe("messages");
  if (screen?.kind !== "messages") throw new Error("not a message list");
  expect(screen.currentSelected).toBe(true);
  expect(screen.entries.map((entry) => entry.text)).toEqual([...THREE]);
  expect(screen.entries.some((entry) => entry.selected)).toBe(false);
});

test("the status row under an entry is skipped rather than read as a message", () => {
  // Its wording moves with what the turn touched, so it is recognised by sitting under an entry
  // rather than by matching its words.
  const screen = rewindScreen(view(picker(THREE, 0)));
  if (screen?.kind !== "messages") throw new Error("not a message list");
  expect(screen.entries.map((entry) => entry.text)).not.toContain("⚠ No code restore");
});

test("finds which row the marker is on", () => {
  const screen = rewindScreen(view(picker(THREE, 2)));
  if (screen?.kind !== "messages") throw new Error("not a message list");
  expect(screen.currentSelected).toBe(false);
  expect(screen.entries.find((entry) => entry.selected)?.text).toBe("BRAVO two. Reply with just OK.");
});

test("reads the confirm menu by label, because its numbers move", () => {
  // With code available the menu grows and `Restore conversation` is no longer first, which is the
  // whole reason nothing here presses a number.
  const withCode = rewindScreen(view(confirm(
    ["Restore code", "Restore code and conversation", "Restore conversation", "Never mind"],
    0,
  )));

  expect(withCode?.kind).toBe("confirm");
  if (withCode?.kind !== "confirm") throw new Error("not a confirm menu");
  expect(withCode.options.map((option) => option.label)).toEqual([
    "Restore code",
    "Restore code and conversation",
    "Restore conversation",
    "Never mind",
  ]);
  expect(withCode.options.findIndex((option) => option.selected)).toBe(0);
});

test("an ordinary composer is neither screen", () => {
  expect(rewindScreen(view(composer()))).toBeNull();
  expect(rewindScreen(view(composer("half a sentence")))).toBeNull();
});

test("a truncated entry still matches the message it stands for", () => {
  expect(saysTheSame("Have a look at the thing we…", "Have a look at the thing we talked about")).toBe(true);
  expect(saysTheSame("one two three", "one\n  two   three")).toBe(true);
  expect(saysTheSame("Have a look at something else…", "Have a look at the thing")).toBe(false);
  expect(saysTheSame("", "anything")).toBe(false);
});

test("walks back the asked-for number of messages and takes conversation only", async () => {
  const driven = pane({ messages: THREE });

  const outcome = await rewindTmuxSession(
    SESSION,
    { fromEnd: 2, text: "BRAVO two. Reply with just OK." },
    driven,
  );

  expect(outcome).toEqual({ rewound: true, composer: "BRAVO two. Reply with just OK." });
  // Two Ups for two messages back, and no number pressed at the confirm menu.
  expect(driven.sent.filter((keys) => keys === UP).length).toBe(2);
  expect(driven.sent.join("")).toContain("/rewind");
  expect(driven.sent.join("")).not.toMatch(/[1-9]\r/);
});

test("reports what the rewind left in the composer, rather than clearing it", async () => {
  // Rewinding puts the rewound-to message back in the box. A caller that is about to type a brief
  // needs to know that, and one that is not needs to be told rather than surprised.
  const driven = pane({ messages: THREE });

  const outcome = await rewindTmuxSession(SESSION, { fromEnd: 1, text: "CHARLIE three." }, driven);

  expect(outcome).toEqual({ rewound: true, composer: "CHARLIE three." });
});

test("walks the confirm menu to the conversation option instead of assuming it is first", async () => {
  // With code available the menu grows and the conversation restore is no longer option one, which
  // is the whole reason nothing here presses a number.
  const driven = pane({
    messages: THREE,
    confirmOptions: ["Restore code", "Restore code and conversation", "Restore conversation"],
  });

  const outcome = await rewindTmuxSession(SESSION, { fromEnd: 1, text: "CHARLIE three." }, driven);

  expect(outcome).toEqual({ rewound: true, composer: "CHARLIE three." });
  expect(driven.sent.filter((keys) => keys === DOWN).length).toBe(2);
});

test("refuses when the row it landed on is not the message it was told to reach", async () => {
  // The failure this exists for: a list shorter than the caller believed CLAMPS at the oldest
  // entry rather than failing, and a rewind to the wrong message is silent and unrecoverable.
  const driven = pane({ messages: THREE });

  const outcome = await rewindTmuxSession(
    SESSION,
    { fromEnd: 5, text: "a message this conversation never held" },
    driven,
  );

  expect(outcome).toEqual({ rewound: false, reason: "wrong-message" });
  // Four Ups for three messages, not five: the fourth moved nothing, which is how the top is
  // recognised. Walking the rest would spend the redraw budget once per step to arrive at the row
  // it was already on.
  expect(driven.sent.filter((keys) => keys === UP).length).toBe(4);
  // Escaped rather than left open, because a pane with a menu up is one nobody can type into.
  expect(driven.sent.filter((keys) => keys === ESCAPE).length).toBe(2);
});

test("refuses a confirm menu with no conversation-only option, rather than taking another", async () => {
  const driven = pane({
    messages: THREE,
    confirmOptions: ["Restore code", "Summarize from here", "Never mind"],
  });

  const outcome = await rewindTmuxSession(SESSION, { fromEnd: 1, text: "CHARLIE three." }, driven);

  expect(outcome).toEqual({ rewound: false, reason: "no-conversation-option" });
  // Nothing was confirmed: the only Return sent was the one that opened this menu.
  expect(driven.sent.filter((keys) => keys === CARRIAGE_RETURN).length).toBe(1);
});

test("refuses a picker that did not open where every picker opens", async () => {
  // Its opening selection is the only fixed point this has, so a picker that opened anywhere else
  // is one whose position cannot be reasoned about.
  const driven = pane({ messages: THREE, opensAt: 2 });

  const outcome = await rewindTmuxSession(SESSION, { fromEnd: 1, text: "CHARLIE three." }, driven);

  expect(outcome).toEqual({ rewound: false, reason: "not-at-current" });
});

test("refuses when the command opened no picker at all", async () => {
  const driven = pane({ messages: THREE, deaf: true });

  const outcome = await rewindTmuxSession(SESSION, { fromEnd: 1, text: "CHARLIE three." }, driven);

  expect(outcome).toEqual({ rewound: false, reason: "no-picker" });
});

test("refuses a composer with unsent text in it", async () => {
  // The same refusal the rename makes: the only way to run a command in a box is to type it where
  // the reader was writing.
  const driven = pane({ messages: THREE, composerHolds: "half a thought" });

  const outcome = await rewindTmuxSession(SESSION, { fromEnd: 1, text: "CHARLIE three." }, driven);

  expect(outcome).toEqual({ rewound: false, reason: "composer-busy" });
  expect(driven.sent).toEqual([]);
});

test("refuses a session with no pane, without asking tmux anything else", async () => {
  const driven = pane({ messages: THREE });

  const outcome = await rewindTmuxSession(
    SESSION,
    { fromEnd: 1, text: "CHARLIE three." },
    { ...driven, pane: async () => null },
  );

  expect(outcome).toEqual({ rewound: false, reason: "no-pane" });
  expect(driven.sent).toEqual([]);
});

test("refuses a target it would have to walk further than it is willing to", async () => {
  const driven = pane({ messages: THREE });
  for (const fromEnd of [0, -1, MAX_REWIND_STEPS + 1]) {
    expect(await rewindTmuxSession(SESSION, { fromEnd, text: "x" }, driven))
      .toEqual({ rewound: false, reason: "wrong-message" });
  }
  expect(driven.sent).toEqual([]);
});
