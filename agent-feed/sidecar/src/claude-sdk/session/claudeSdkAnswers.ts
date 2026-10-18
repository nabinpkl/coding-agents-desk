// An AskUserQuestion call as the sidecar reads it from the callback its runner holds: the questions
// it asks, and whether a reader's answers fit them, in the shape the SDK takes back. Pure, so its
// rules are tested without a runner.

import type { ClaudeSdkQuestion, TmuxQuestionAnswer } from "@agentdesk/agent-feed-wire";

/** The questions of an AskUserQuestion call, or null when the input is not that shape. */
export function askedQuestions(input: Record<string, unknown>): ClaudeSdkQuestion[] | null {
  const questions = input.questions;
  if (!Array.isArray(questions) || questions.length === 0) return null;
  const parsed: ClaudeSdkQuestion[] = [];
  for (const entry of questions) {
    if (entry === null || typeof entry !== "object") return null;
    const { question, header, multiSelect, options } = entry as Record<string, unknown>;
    if (typeof question !== "string" || !Array.isArray(options)) return null;
    parsed.push({
      question,
      header: typeof header === "string" ? header : "",
      multiSelect: multiSelect === true,
      options: options.map((option) => {
        const { label, description } = (option ?? {}) as Record<string, unknown>;
        return { label: String(label ?? ""), description: typeof description === "string" ? description : "" };
      }),
    });
  }
  return parsed;
}

export type AnswersFit =
  | { ok: true; answers: Record<string, string> }
  | { ok: false; refused: "wrong-dialog" | "wrong-option"; message: string };

/**
 * The SDK's answers for one call, keyed by question text, or the reason they do not fit it.
 *
 * Matched by the text of every question, in order, the rule the terminal dialog's driver answers
 * by: position picks the row and text decides whether to go through with it. A choice is checked
 * by index AND label, so an option list that changed under the reader is refused rather than
 * answered with whatever now sits at that index.
 */
export function sdkAnswers(
  questions: readonly ClaudeSdkQuestion[],
  answers: readonly TmuxQuestionAnswer[],
): AnswersFit {
  if (questions.length !== answers.length || questions.some((asked, at) => asked.question !== answers[at]!.question)) {
    return { ok: false, refused: "wrong-dialog", message: "the answers do not describe the question that is waiting" };
  }
  const result: Record<string, string> = {};
  for (const [at, asked] of questions.entries()) {
    const answer = answers[at]!;
    if (!asked.multiSelect && answer.chosen.length > 1) {
      return { ok: false, refused: "wrong-option", message: `"${asked.question}" takes one answer` };
    }
    for (const pick of answer.chosen) {
      if (asked.options[pick.index]?.label !== pick.label) {
        return {
          ok: false,
          refused: "wrong-option",
          message: `"${pick.label}" is not option ${pick.index + 1} of "${asked.question}"`,
        };
      }
    }
    const said = [...answer.chosen.map((pick) => pick.label), ...(answer.other.trim() ? [answer.other.trim()] : [])];
    if (said.length === 0) return { ok: false, refused: "wrong-option", message: `"${asked.question}" has no answer` };
    result[asked.question] = said.join(", ");
  }
  return { ok: true, answers: result };
}
