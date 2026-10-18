// The command menu Claude draws under the composer box, read as a list of commands, and the other
// things drawn in the same rows that are not one. Split from the composer's main suite, which
// covers reading and writing the box itself.

import { expect, test } from "bun:test";
import { clearPressesFor, RULE, screenWith } from "@/input/tmuxComposerHarness";
import { composerBox } from "@/input/tmuxComposer";
import type { TmuxPaneView } from "@/terminal/tmux/tmuxSessions";

function menuScreen(rows: string[], typed: string): TmuxPaneView {
  const screen = [RULE, `❯ ${typed}`, RULE, ...rows].join("\n");
  return { screen, cursor: { row: 1, column: 2 + typed.length } };
}

test("reads the command menu Claude draws under the box, and rejoins a wrapped description", () => {
  // Captured from a live pane after pasting "/re". The selected row is a different colour from
  // the rest -- 153 against 246 here -- and the arrows move which one carries it.
  const box = composerBox(
    menuScreen(
      [
        "\u001b[39m  \u001b[38;5;153m/\u001b[1mre\u001b[0m\u001b[38;5;153mcap                          Generate a one-line session \u001b[1mre\u001b[0m\u001b[38;5;153mcap now\u001b[39m",
        "  \u001b[38;5;246m/\u001b[1m\u001b[39mre\u001b[0m\u001b[38;5;246msume                         \u001b[1m\u001b[39mRe\u001b[0m\u001b[38;5;246msume a previous conversation\u001b[39m",
        "  \u001b[38;5;246m/\u001b[1m\u001b[39mre\u001b[0m\u001b[38;5;246mwind\u001b[39m                         \u001b[1mRe\u001b[0m\u001b[38;5;246mstore\u001b[39m \u001b[38;5;246mthe code and/or conversation to a\u001b[39m",
        "                                  \u001b[38;5;246mp\u001b[1m\u001b[39mre\u001b[0m\u001b[38;5;246mvious point\u001b[39m",
      ],
      "/re",
    ),
  )!;
  expect(box.commands).toEqual([
    { name: "/recap", description: "Generate a one-line session recap now", selected: true },
    { name: "/resume", description: "Resume a previous conversation", selected: false },
    {
      name: "/rewind",
      // The two rows it wrapped onto, rejoined. Claude wraps the description itself, so the row
      // break is a rendering and not part of what it says.
      description: "Restore the code and/or conversation to a previous point",
      selected: false,
    },
  ]);
});

test("reads no menu out of the status lines that stand in the same rows", () => {
  // What is under the box when nothing is open, verbatim. The menu is drawn INTO these rows, so
  // "is there a menu" and "is this the footer" are one question, answered by shape.
  const box = composerBox(
    menuScreen(
      [
        "\u001b[39m  \u001b[38;5;246mcomposer-probe  Opus 5 (1M context)  ctx:5%  5h:13%\u001b[39m",
        "  \u001b[38;5;73m⏸ plan mode on\u001b[38;5;246m (shift+tab to cycle)\u001b[39m",
        "                                                          \u001b[38;5;246m49597 tokens\u001b[39m",
      ],
      "ordinary text",
    ),
  )!;
  expect(box.commands).toEqual([]);
});

test("declines the @ menu, which shares the region and is not a list of commands", () => {
  // Measured on a live pane: its rows are `◇ resource – description` with no leading slash, so the
  // entry pattern turns them down by shape. A reader who opens it sees no list, rather than a
  // list of the wrong things.
  const box = composerBox(
    menuScreen(
      [
        "\u001b[39m  \u001b[38;5;246m◇ claude.ai Figma:ui://widget/f… – figjam-diagram-mcp-app\u001b[39m",
        "  \u001b[38;5;246m◇ claude.ai Figma:skill://index… – skill-index\u001b[39m",
      ],
      "@",
    ),
  )!;
  expect(box.commands).toEqual([]);
});

test("does not read a path in the footer as a command", () => {
  // The narrow name pattern is what stops this: a command name carries no second slash, so a row
  // showing a directory declines even though it starts the same way.
  const box = composerBox(
    menuScreen(["  /Users/dev/projects/agent-desk        the working directory"], "ordinary text"),
  )!;
  expect(box.commands).toEqual([]);
});

test("stops at the bottom rule rather than swallowing the status lines", () => {
  expect(composerBox(screenWith(["hello"]))).toEqual({
    rows: ["hello"],
    hint: null,
    exact: true,
    commands: [],
    clearPresses: clearPressesFor(["hello"]),
  });
});
