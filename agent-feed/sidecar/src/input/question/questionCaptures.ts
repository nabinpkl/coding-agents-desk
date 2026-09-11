// Screens `tmux capture-pane -p` took off real 120x40 and 120x44 panes on 2026-09-11, from Claude
// Code 2.1.268 running Haiku 4.5, kept verbatim from the dialog's opening rule to its footer.
//
// Its own module for the reason `rewindPickerCaptures.ts` gives: these are a RECORD of what the
// renderer does, not a convenience for the parser. Every shape here differs from the others in a
// way that changed the parse, and several of them contradict what the tool's own JSON would let
// you assume. If the renderer changes, re-take these rather than editing them to agree with
// whatever the parser does by then.
//
// How to take them again: a throwaway `claude --model haiku` in a scratch directory, then a prompt
// asking for one AskUserQuestion call of the shape wanted ("exactly two questions, Q1 multiSelect
// TRUE ..."). Haiku obliges directly, which is why it is the model named here.

/** One captured screen and what the parser must read out of it. */
export interface QuestionCapture {
  name: string;
  screen: string;
  /** The tab labels, in order, Submit included when the dialog draws one. */
  tabs: readonly string[];
  /** The question text, or null on the review screen. */
  question: string | null;
  /** Every row inside the box, as `<marker><number>. <text>`, the marker being `>` or a space. */
  rows: readonly string[];
  multiSelect: boolean;
  review: boolean;
}

export const CAPTURES: readonly QuestionCapture[] = [
  {
    // The only shape that draws no arrows and no Submit tab: one question, one answer, so there is
    // nothing to navigate between and nothing to confirm. The tab row is still there.
    name: "one single-select question",
    screen: [
      "────────────────────────────────────────────────────────────",
      " ☐ Colour",
      "",
      "Which colour should the probe use?",
      "",
      "❯ 1. ALPHA",
      "     A bold, high-contrast primary colour for maximum visibility.",
      "  2. BRAVO",
      "     A neutral, subtle colour for minimal visual interference.",
      "  3. CHARLIE",
      "     A balanced mid-tone colour for general-purpose visibility.",
      "  4. Type something.",
      "────────────────────────────────────────────────────────────",
      "  5. Chat about this",
      "",
      "Enter to select · ↑/↓ to navigate · Esc to cancel",
    ].join("\n"),
    tabs: ["Colour"],
    question: "Which colour should the probe use?",
    rows: [">1. ALPHA", " 2. BRAVO", " 3. CHARLIE", " 4. Type something."],
    multiSelect: false,
    review: false,
  },
  {
    // Multi-select brings three things the single-select shape has none of: a Submit tab (an answer
    // needs an explicit commit), a checkbox per row, and an inline button under the rows. It also
    // indents its descriptions by TWO spaces where the single-select shape uses five, which is why
    // nothing here parses on indentation depth.
    name: "one multi-select question",
    screen: [
      "────────────────────────────────────────────────────────────",
      "←  ☐ Toppings  ✔ Submit  →",
      "",
      "Which toppings do you want?",
      "",
      "❯ 1. [ ] DELTA",
      "  A crispy textured layer that adds structural support.",
      "  2. [ ] ECHO",
      "  A reflective coating that enhances visibility.",
      "  3. [ ] FOXTROT",
      "  A protective finish that improves durability.",
      "  4. [ ] GOLF",
      "  An adhesive component that strengthens bonding.",
      "  5. [ ] Type something",
      "     Submit",
      "────────────────────────────────────────────────────────────",
      "  6. Chat about this",
      "",
      "Enter to select · ↑/↓ to navigate · Esc to cancel",
    ].join("\n"),
    tabs: ["Toppings", "Submit"],
    question: "Which toppings do you want?",
    rows: [
      ">1. [ ] DELTA",
      " 2. [ ] ECHO",
      " 3. [ ] FOXTROT",
      " 4. [ ] GOLF",
      " 5. [ ] Type something",
    ],
    multiSelect: true,
    review: false,
  },
  {
    // Three questions, the first two answered. Two readings come only from here: an answered
    // single-select row carries a TRAILING tick rather than a marker, and the cursor is back on
    // row one rather than on the answered row -- so the cursor says nothing about the answer.
    name: "three questions, two answered",
    screen: [
      "────────────────────────────────────────────────────────────",
      "←  ☒ One  ☒ Two  ☐ Three  ✔ Submit  →",
      "",
      "Pick one?",
      "",
      "❯ 1. AAA",
      "     First option.",
      "  2. BBB ✔",
      "     Second option.",
      "  3. Type something.",
      "────────────────────────────────────────────────────────────",
      "  4. Chat about this",
      "",
      "Enter to select · Tab/Arrow keys to navigate · Esc to cancel",
    ].join("\n"),
    tabs: ["One", "Two", "Three", "Submit"],
    question: "Pick one?",
    rows: [">1. AAA", " 2. BBB ✔", " 3. Type something."],
    multiSelect: false,
    review: false,
  },
  {
    // A multi-select question that is not the last one: its inline button reads `Next` rather than
    // `Submit`. The free-text row keeps its own tick independently of its text, and the cursor is
    // on it -- which is the state in which arrows and digits stop meaning what they mean anywhere
    // else on this screen.
    name: "multi-select with typed free text",
    screen: [
      "────────────────────────────────────────────────────────────",
      "←  ☒ Many  ☐ Solo  ✔ Submit  →",
      "",
      "Pick many?",
      "",
      "  1. [✔] KKK",
      "  First option for multiple selection",
      "  2. [ ] LLL",
      "  Second option for multiple selection",
      "❯ 3. [✔] typed on the multi other",
      "     Next",
      "────────────────────────────────────────────────────────────",
      "  4. Chat about this",
      "",
      "Enter to select · Tab/Arrow keys · ctrl+g to edit in VS Code · Esc to cancel",
    ].join("\n"),
    tabs: ["Many", "Solo", "Submit"],
    question: "Pick many?",
    rows: [" 1. [\u2714] KKK", " 2. [ ] LLL", ">3. [\u2714] typed on the multi other"],
    multiSelect: true,
    review: false,
  },
  {
    // The review screen. No closing rule, no `Chat about this`, and NO FOOTER, so the anchor every
    // other shape parses from is absent here and this one is found by its own prose instead.
    name: "the review screen",
    screen: [
      "────────────────────────────────────────────────────────────",
      "←  ☒ Toppings  ✔ Submit  →",
      "",
      "Review your answers",
      "",
      " ● Which toppings do you want?",
      "   → ECHO, GOLF, DELTA",
      "",
      "Ready to submit your answers?",
      "",
      "❯ 1. Submit answers",
      "  2. Cancel",
      "",
      "",
    ].join("\n"),
    tabs: ["Toppings", "Submit"],
    question: null,
    rows: [">1. Submit answers", " 2. Cancel"],
    multiSelect: false,
    review: true,
  },
  {
    // The review screen refusing to be finished, which is what a dialog with an unanswered
    // question looks like from here. `Submit answers` is still offered.
    name: "the review screen with a question unanswered",
    screen: [
      "────────────────────────────────────────────────────────────",
      "←  ☐ One  ☐ Two  ☐ Three  ✔ Submit  →",
      "",
      "Review your answers",
      "",
      "⚠ You have not answered all questions",
      "",
      "Ready to submit your answers?",
      "",
      "❯ 1. Submit answers",
      "  2. Cancel",
    ].join("\n"),
    tabs: ["One", "Two", "Three", "Submit"],
    question: null,
    rows: [">1. Submit answers", " 2. Cancel"],
    multiSelect: false,
    review: true,
  },
];
