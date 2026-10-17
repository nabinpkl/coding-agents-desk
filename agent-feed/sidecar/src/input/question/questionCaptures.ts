// Screens `tmux capture-pane -p` took off real panes, kept verbatim from the dialog's opening
// rule to its footer: 120x40 and 120x44 on 2026-09-11 from Claude Code 2.1.268, and 80x24 on
// 2026-09-15, both running Haiku 4.5, and one 80x24 screen from 2.1.296 on 2026-10-14.
//
// The width is part of the record. Every screen here was 120 columns wide until the last one,
// and the footer fits on one row at 120 and does not at 80 -- so the parser agreed with every
// capture in this file while failing on the pane sizes this repo actually runs.
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
  {
    // An 80-column pane, mid-answer, and the screen that broke the reader: the cursor is on the
    // free-text row, so Claude has added `ctrl+g to edit in VS Code` to the footer, taking it to 84
    // characters -- and at this width `Esc to cancel` is split across two rows with no line holding
    // it. Every other capture here is 120 columns wide, where that same footer fits on one row.
    name: "multi-select mid-answer on an 80-column pane",
    screen: [
      "────────────────────────────────────────────────────────────────────────────────",
      "\u2190  \u2612 Fruit  \u2612 Days  \u2610 Tone  \u2714 Submit  \u2192",
      "",
      "Which days?",
      "",
      "  1. [\u2714] Mon",
      "  Monday",
      "  2. [ ] Tue",
      "  Tuesday",
      "  3. [ ] Wed",
      "  Wednesday",
      "\u276f 4. [ ] Type something",
      "     Next",
      "────────────────────────────────────────────────────────────────────────────────",
      "  5. Chat about this",
      "",
      "Enter to select \u00b7 Tab/Arrow keys to navigate \u00b7 ctrl+g to edit in VS Code \u00b7 Esc",
      "to cancel",
    ].join("\n"),
    tabs: ["Fruit", "Days", "Tone", "Submit"],
    question: "Which days?",
    rows: [" 1. [\u2714] Mon", " 2. [ ] Tue", " 3. [ ] Wed", ">4. [ ] Type something"],
    multiSelect: true,
    review: false,
  },
  {
    // Taller than its own pane, which is the shape no other capture here has. Four options with a
    // fifty-word description on each put the opening rule, the tab row and the question text 40
    // rows above the top of an 80x24 screen, so a reader given only the screen sees the closing
    // rule, `Chat about this` and a footer -- and no dialog at all. Taken with the scrollback
    // included, which is what `captureQuestionViewArgs` asks tmux for.
    name: "a question taller than the pane",
    screen: [
      "────────────────────────────────────────────────────────────────────────────────",
      " ☐ Rollout",
      "",
      "Which rollout plan should we take for the new mirror behaviour?",
      "",
      "❯ 1. Attach the pane whenever a question is open",
      "     This approach keeps a persistent connection to the terminal pane for any",
      "     session that has an open question, allowing the panel to reflect the",
      "     reader's cursor position and responses in real time without requiring any",
      "     interaction. The panel stays synchronized with the pane automatically,",
      "     providing immediate feedback and visibility into what is happening in the",
      "     terminal. This costs a pipe connection per session with an open question,",
      "     but ensures the mirror is always current and responsive.",
      "  2. Attach only after the reader touches the question",
      "     This strategy maintains the existing attach-on-intent principle where the",
      "     pane connection only activates when you explicitly interact with the",
      "     question by clicking an option or entering text into a field. This approach",
      "     is more resource-efficient and avoids attaching pipes to sessions where",
      "     the reader may not be actively engaging. The tradeoff is that the initial",
      "     state of the question may be slightly stale, though subsequent interactions",
      "     will reflect the current state once you touch it.",
      "  3. Poll the pane on a timer while a question is open",
      "     This method periodically checks the pane state at regular intervals",
      "     whenever a question is open in the terminal, rather than maintaining a",
      "     continuous connection. The panel requests updates at a fixed cadence to see",
      "     cursor position and any changes made in the terminal. This balances",
      "     responsiveness with resource usage by avoiding a persistent pipe while",
      "     still capturing state changes during active questioning periods, though",
      "     there will be a slight delay between terminal changes and panel updates.",
      "  4. Leave the mirror one-way and change nothing",
      "     This option preserves the current behavior where the panel draws content",
      "     solely from the transcript and commits answers written in the panel",
      "     directly to the pane, but never observes or reflects back what someone does",
      "     in the terminal itself. The mirror remains unidirectional, keeping the",
      "     implementation simple and avoiding any new resource costs, though the panel",
      "     will not show cursor position or real-time changes made directly in the",
      "     terminal.",
      "  5. Type something.",
      "────────────────────────────────────────────────────────────────────────────────",
      "  6. Chat about this",
      "",
      "Enter to select · ↑/↓ to navigate · Esc to cancel",
    ].join("\n"),
    tabs: ["Rollout"],
    question: "Which rollout plan should we take for the new mirror behaviour?",
    rows: [
      ">1. Attach the pane whenever a question is open",
      " 2. Attach only after the reader touches the question",
      " 3. Poll the pane on a timer while a question is open",
      " 4. Leave the mirror one-way and change nothing",
      " 5. Type something.",
    ],
    multiSelect: false,
    review: false,
  },
  {
    // The shape that made answering a question fail outright, and the reason this file says width
    // is part of the record: a SINGLE-SELECT question whose options carry previews is drawn in two
    // columns, so every option row also holds a slice of the preview panel beside it. Read without
    // cutting to the band, row one says `Iron` followed by the panel's own top border, and the
    // label check before any key goes out refuses it as `wrong-option`. There is also no
    // `Type something.` row here at all: this shape's free text is the `Notes` field below.
    name: "a two-column question, nothing answered",
    screen: [
      "────────────────────────────────────────────────────────────────────────────────",
      "←  ☐ Metal  ☐ Grip  ✔ Submit  →",
      "",
      "Which metal appeals to you?",
      "",
      "❯ 1. Iron                         ┌──────────────────────────────────────────┐",
      "  2. Tin                          │ ┌─────────┐                              │",
      "                                  ├─── ✂ ─── 5 lines hidden ─────────────────┤",
      "                                  └──────────────────────────────────────────┘",
      "",
      "                                  Notes: press n to add notes",
      "",
      "────────────────────────────────────────────────────────────────────────────────",
      "  Chat about this",
      "",
      "Enter to select · ↑/↓ to navigate · n to add notes · Tab to switch questions ·",
      "Esc to cancel",
    ].join("\n"),
    tabs: ["Metal", "Grip", "Submit"],
    question: "Which metal appeals to you?",
    rows: [">1. Iron", " 2. Tin"],
    multiSelect: false,
    review: false,
  },
  {
    // The same shape with a long label, an answer and a note. Three readings come only from here.
    // A wrapped label continues inside the band, so the panel keeps drawing to the right of it. An
    // answered row's tick sits INSIDE the band rather than at the end of the line, which is why it
    // is still found after the cut. And the tick eats into the band, so less of that label is
    // recoverable here than on the same row unanswered -- `A deliberately very` against
    // `A deliberately very long`.
    name: "a two-column question answered, with a note",
    screen: [
      "────────────────────────────────────────────────────────────────────────────────",
      "←  ☒ Alpha  ☐ Beta  ☐ Gamma  ✔ Submit  →",
      "",
      "Which option do you prefer for Alpha?",
      "",
      "❯ 1. A short one                  ┌──────────────────────────────────────────┐",
      "  2. A deliberately very     ✔    │ Short option                             │",
      "    long option label that        ├─── ✂ ─── 4 lines hidden ─────────────────┤",
      "    will certainly not fit        └──────────────────────────────────────────┘",
      "    inside a narrow column",
      "                                  Notes: combo note",
      "",
      "────────────────────────────────────────────────────────────────────────────────",
      "  Chat about this",
      "",
      "Enter to select · ↑/↓ to navigate · n to add notes · Tab to switch questions ·",
      "Esc to cancel",
    ].join("\n"),
    tabs: ["Alpha", "Beta", "Gamma", "Submit"],
    question: "Which option do you prefer for Alpha?",
    rows: [">1. A short one", " 2. A deliberately very ✔"],
    multiSelect: false,
    review: false,
  },
  {
    // The same question on a 120-column pane, which is here to settle what the band does with the
    // extra room: nothing. It stays 34 columns wide and the preview panel keeps its own width, so
    // the whole block is drawn the same and only the rules and the footer grow. A reader that had
    // worked out the band from the pane width would have been right at 80 and wrong here.
    name: "a two-column question on a 120-column pane",
    screen: [
      "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
      "←  ☐ Alpha  ☐ Beta  ☐ Gamma  ✔ Submit  →",
      "",
      "Which option do you prefer for Alpha?",
      "",
      "❯ 1. A short one                  ┌──────────────────────────────────────────┐",
      "  2. A deliberately very long     │ Short option                             │",
      "    option label that will        │ content here                             │",
      "    certainly not fit inside a    │ line three                               │",
      "    narrow column                 │ line four                                │",
      "                                  ├─── ✂ ─── 1 lines hidden ─────────────────┤",
      "                                  └──────────────────────────────────────────┘",
      "",
      "                                  Notes: press n to add notes",
      "",
      "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
      "  Chat about this",
      "",
      "Enter to select · ↑/↓ to navigate · n to add notes · Tab to switch questions · Esc to cancel",
    ].join("\n"),
    tabs: ["Alpha", "Beta", "Gamma", "Submit"],
    question: "Which option do you prefer for Alpha?",
    rows: [">1. A short one", " 2. A deliberately very long"],
    multiSelect: false,
    review: false,
  },  {
    // Claude Code 2.1.296, 80x24, taken 2026-10-14. The question is drawn behind a `│` bar on
    // every one of its rows, which no earlier capture has: read as text, the bar became the start
    // of the question, so it matched no tool call and the driver refused every answer as
    // `wrong-dialog`. The question also wraps, which is what the panel's copy of it joins back up.
    name: "a wrapped question behind a bar on an 80-column pane",
    screen: [
      "────────────────────────────────────────────────────────────────────────────────",
      "←  ☐ Source  ✔ Submit  →",
      "",
      "│ Where do the secrets you want to store usually come from? You may pick every",
      "│ source that applies.",
      "",
      "❯ 1. [ ] Environment variables",
      "         Your application reads secrets from .env files or system environment",
      "         variables during development or deployment. These are typically set",
      "         locally or in CI/CD systems like GitHub Actions or Docker.",
      "  2. [ ] Password managers",
      "         Secrets are stored in password managers like 1Password, LastPass, or",
      "         macOS Keychain and accessed when needed. You retrieve them manually or",
      "         through automation tools that integrate with these managers.",
      "  3. [ ] External services",
      "         Secrets come from third-party services, APIs, or cloud platforms that",
      "         you connect to during runtime. Examples include database connection",
      "         strings, OAuth tokens, or API keys from cloud providers.",
      "  4. [ ] Type something",
      "     Submit",
      "────────────────────────────────────────────────────────────────────────────────",
      "  5. Chat about this",
      "",
      "Enter to select · ↑/↓ to navigate · Esc to cancel",
    ].join("\n"),
    tabs: ["Source", "Submit"],
    question: "Where do the secrets you want to store usually come from? You may pick every",
    rows: [
      ">1. [ ] Environment variables",
      " 2. [ ] Password managers",
      " 3. [ ] External services",
      " 4. [ ] Type something",
    ],
    multiSelect: true,
    review: false,
  },
  {
    // The same dialog's review screen, as the driver reads it WITH the scrollback above the pane.
    // The question screen was taller than the pane, so its own tab row had scrolled into history,
    // and the review screen then drew its tab row directly under it: two tab rows, the stale one
    // still saying `☐`. Read off the line after the rule, the stale one is what came back, and the
    // driver refused a fully answered dialog as `wrong-dialog` at its last step.
    name: "a review screen under a stale tab row",
    screen: [
      "────────────────────────────────────────────────────────────────────────────────",
      "←  ☐ Source  ✔ Submit  →",
      "←  ☒ Source  ✔ Submit  →",
      "",
      "Review your answers",
      "",
      " │ ● Where do the secrets you want to store usually come from? You may pick",
      " │   every source that applies.",
      "   → Password managers, External services",
      "",
      "Ready to submit your answers?",
      "",
      "❯ 1. Submit answers",
      "  2. Cancel",
    ].join("\n"),
    tabs: ["Source", "Submit"],
    question: null,
    rows: [">1. Submit answers", " 2. Cancel"],
    multiSelect: false,
    review: true,
  },
];
