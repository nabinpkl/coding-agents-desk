// The answers a reader is building for an ask_owner call, before any of them is sent.
//
// Pure, so the rules are tested without a surface. Text a person typed -- a note, an answer in
// words -- stays in the draft until the call carrying it is delivered, so a refusal leaves every
// word where it was written.

import type { AskOwnerAnswer, AskOwnerQuestion } from "@agentdesk/agent-feed-wire";

/** What one question has been answered with so far. */
export interface AskOwnerDraft {
  /** Chosen option indices, in the order they were picked. */
  chosen: number[];
  /**
   * The note written on each option, by index. Kept for an option that has since been unpicked,
   * so picking it again brings its note back; only a chosen option's note is sent.
   */
  notes: Record<number, string>;
  /** The whole answer to a "text" question, or "something else" on one with options. */
  text: string;
}

export function emptyDrafts(questions: readonly AskOwnerQuestion[]): AskOwnerDraft[] {
  return questions.map(() => ({ chosen: [], notes: {}, text: "" }));
}

function update(
  drafts: readonly AskOwnerDraft[],
  at: number,
  change: (draft: AskOwnerDraft) => AskOwnerDraft,
): AskOwnerDraft[] {
  return drafts.map((draft, position) => (position === at ? change(draft) : draft));
}

/**
 * Picks or unpicks one option. On a "single" question an option and words are alternatives, so
 * picking one clears the words; picking the option already chosen unpicks it.
 */
export function chooseOption(
  drafts: readonly AskOwnerDraft[],
  at: number,
  option: number,
  question: AskOwnerQuestion,
): AskOwnerDraft[] {
  return update(drafts, at, (draft) => {
    if (question.kind === "single") {
      return draft.chosen[0] === option ? { ...draft, chosen: [] } : { ...draft, chosen: [option], text: "" };
    }
    const chosen = draft.chosen.includes(option)
      ? draft.chosen.filter((each) => each !== option)
      : [...draft.chosen, option];
    return { ...draft, chosen };
  });
}

/** Writes the note on one option. */
export function writeNote(drafts: readonly AskOwnerDraft[], at: number, option: number, note: string): AskOwnerDraft[] {
  return update(drafts, at, (draft) => ({ ...draft, notes: { ...draft.notes, [option]: note } }));
}

/**
 * Writes a question's words. On a "single" question typing replaces the option chosen, as picking
 * one replaces the words; on a "multi" one they stand side by side.
 */
export function writeText(
  drafts: readonly AskOwnerDraft[],
  at: number,
  text: string,
  question: AskOwnerQuestion,
): AskOwnerDraft[] {
  return update(drafts, at, (draft) => ({
    ...draft,
    chosen: question.kind === "single" && text.length > 0 ? [] : draft.chosen,
    text,
  }));
}

/** Whether this question has anything to send. */
export function isAnswered(draft: AskOwnerDraft): boolean {
  return draft.chosen.length > 0 || draft.text.trim().length > 0;
}

/**
 * The answers in wire shape, or null while one of the questions has none. Every question is
 * answered before anything is sent: the session asked them together and waits for all of them.
 */
export function toAnswers(
  questions: readonly AskOwnerQuestion[],
  drafts: readonly AskOwnerDraft[],
): AskOwnerAnswer[] | null {
  if (questions.length !== drafts.length) return null;
  const answers: AskOwnerAnswer[] = [];
  for (const [at, question] of questions.entries()) {
    const draft = drafts[at]!;
    if (!isAnswered(draft)) return null;
    const text = draft.text.trim();
    answers.push({
      id: question.id,
      chosen: draft.chosen.map((option) => {
        const note = draft.notes[option]?.trim() ?? "";
        return { label: question.options[option]?.label ?? "", ...(note ? { note } : {}) };
      }),
      ...(text ? { text } : {}),
    });
  }
  return answers;
}
