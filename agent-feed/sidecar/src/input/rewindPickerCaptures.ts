// Screens `tmux capture-pane -p` took off a real 120x40 pane on 2026-09-10, from Claude Code
// 2.1.267, kept verbatim from the title row to the footer -- which is the region the parser reads.
//
// Its own module because they are a record rather than a test: each is a shape the rewind list
// takes when something other than an ordinary run produced it, and each was read an entry out of
// step by the parser that skipped one row after every entry. If the renderer changes, these are
// re-taken rather than edited to agree with whatever the parser does by then.
//
// How each was produced, so it can be taken again: a throwaway `claude --model haiku` session in a
// scratch directory, two short turns, then `/rewind`. Checkpointing off is the same with
// `CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING=1` in its environment; the cleared one is a
// `--fork-session` fork that was then `/clear`ed and given one turn; the scrolling one is the
// ordinary session with its pane resized to 18 rows, which is short enough that the list windows.

/** The screens, oldest concern first. */
export const CAPTURES: readonly { name: string; screen: string; entries: readonly string[] }[] = [
  {
    name: "checkpointing off",
    screen: [
      "  Rewind",
      "",
      "  Restore and fork the conversation to the point before…",
      "",
      "    ALPHA one. Reply with just OK.",
      "",
      "    CHARLIE three. Reply with just OK.",
      "",
      "  ❯ (current)",
      "",
      "",
      "  Enter to continue · Esc to cancel",
    ].join("\n"),
    entries: ["ALPHA one. Reply with just OK.", "CHARLIE three. Reply with just OK."],
  },
  {
    name: "a cleared session",
    screen: [
      "  Rewind",
      "",
      "  Restore the code and/or conversation to the point before…",
      "",
      "    /resume 4b5a9413-e3e2-4da5-ba61-2fc72155c2f2 (previous session)",
      "",
      "",
      "    /clear",
      "    No code changes",
      "",
      "    DELTA four. Reply with just OK.",
      "    No code changes",
      "",
      "  ❯ (current)",
      "",
      "",
      "",
      "  Enter to continue · Esc to cancel",
    ].join("\n"),
    entries: [
      "/resume 4b5a9413-e3e2-4da5-ba61-2fc72155c2f2 (previous session)",
      "/clear",
      "DELTA four. Reply with just OK.",
    ],
  },
  {
    name: "a list that scrolls",
    screen: [
      "  Rewind",
      "",
      "  Restore the code and/or conversation to the point before…",
      "",
      "   ↑ 1 more above",
      "",
      "    CHARLIE three. Reply with just OK.",
      "    No code changes",
      "",
      "  ❯ (current)",
      "",
      "",
      "",
      "  Enter to continue · Esc to cancel",
    ].join("\n"),
    entries: ["CHARLIE three. Reply with just OK."],
  },
  {
    name: "a fork of another session",
    screen: [
      "  Rewind",
      "",
      "  Restore the code and/or conversation to the point before…",
      "",
      "    ALPHA one. Reply with just OK.",
      "    No code changes",
      "",
      "    CHARLIE three. Reply with just OK.",
      "    No code changes",
      "",
      "  ❯ (current)",
      "",
      "",
      "",
      "  Enter to continue · Esc to cancel",
    ].join("\n"),
    entries: ["ALPHA one. Reply with just OK.", "CHARLIE three. Reply with just OK."],
  },
];
