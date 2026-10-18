"use client";

// A question the panel knows only because the session's own terminal is drawing it.
//
// The tool call is the content everywhere else, and it is normally in hand: the live mirror
// publishes the asking turn as it streams. Two things leave the panel without it. The CLI writes
// that turn to the transcript only once the dialog is answered, and the live mirror loses a turn
// whenever proxy-agent's capture drops mid-response -- measured 2026-10-14, the capture died 15s
// into a turn, the mirror kept only the turn's thinking, and the question stood in the pane for as
// long as nobody went to the terminal. The pane is then the only witness, so its copy is drawn.
//
// A worse copy, and honest about it. A wrapped label is cut to its first line and its tail lands in
// the detail under it; a dialog of several questions shows the screen only the one it is on, and
// which tab that is is drawn in colour, so the rest cannot be read. Such a call is drawn read-only
// rather than answered: the dialog takes every answer at once, and the panel cannot name the others.

import { useMemo, useState } from "react";
import type { TmuxQuestionState } from "@agentdesk/agent-feed-wire";
import type { OpenAskUserQuestion } from "@/app/askUserQuestion";

/** The open question as the pane draws it, or null when the pane shows none it can be read from. */
export function questionFromPane(pane: TmuxQuestionState | null): OpenAskUserQuestion | null {
  if (!pane || pane.review || pane.question === null) return null;
  const options = pane.options.filter((option) => option.label.trim().length > 0);
  if (options.length === 0) return null;
  return {
    // Keyed by what is on screen, so the draft starts over when the dialog moves to another
    // question and survives every re-reading of the same one.
    callId: `pane:${pane.question}`,
    questions: [
      {
        // The whole drawn question, which starts with the line everything matches by.
        question: pane.prompt ?? pane.question,
        multiSelect: pane.multiSelect,
        options: options.map((option) => ({
          label: option.label,
          ...(option.detail ? { description: option.detail } : {}),
        })),
      },
    ],
    pane: { unseen: Math.max(0, pane.tabs.length - 1) },
  };
}

/**
 * `questionFromPane`, held across the screens of one dialog that draw no question.
 *
 * The review screen is still the dialog, and it is where an answer sent from the panel spends its
 * last step -- so a band that went with the question text would vanish while the answer was in
 * flight, taking any refusal with it. Kept until the pane says the dialog is gone.
 */
export function usePaneQuestion(pane: TmuxQuestionState | null): OpenAskUserQuestion | null {
  const read = useMemo(() => questionFromPane(pane), [pane]);
  const [kept, setKept] = useState<OpenAskUserQuestion | null>(read);
  // Adjusted during render rather than in an effect, so no frame draws the band gone. Bounded:
  // `read` changes identity only when the pane reading does.
  if (read !== null && read !== kept) setKept(read);
  if (pane === null && kept !== null) setKept(null);
  return read ?? (pane === null ? null : kept);
}
