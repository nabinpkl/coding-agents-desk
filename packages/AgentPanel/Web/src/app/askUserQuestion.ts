import type { ActivityEvent } from "@/features/activity-feed/useSessionEventsStream";

/**
 * The transcript/live-feed view of an open AskUserQuestion panel.
 *
 * This is the mirror's CONTENT source: the `AskUserQuestion` tool_use already carries the full
 * question JSON (`input.questions`), and the panel never reads content out of the accessibility tree
 * -- the host's question status augments only live state (selection, Other text, Submit enablement,
 * presence).
 */
export interface AskUserQuestionOption {
  label: string;
  description?: string;
  /**
   * The little diagram or snippet Claude may attach to an option.
   *
   * Kept because the terminal dialog shows it and a reader choosing between two options is often
   * choosing between two previews. It arrives as preformatted text and is rendered as such.
   */
  preview?: string;
}

/** One question of a call. A call carries between one and four of them. */
export interface AskUserQuestionItem {
  question: string;
  header?: string;
  multiSelect: boolean;
  options: AskUserQuestionOption[];
}

export interface OpenAskUserQuestion {
  /** The tool_use id; the matching tool_result closes the question. */
  callId: string;
  /**
   * Every question the call carries, in its own order.
   *
   * All of them, not the first. This used to take `questions[0]` because the surface it mirrored
   * was Claude Desktop's single panel; the terminal draws one tab per question and refuses to
   * submit until each has an answer, so answering only the first there finishes nothing.
   */
  questions: AskUserQuestionItem[];
}

/**
 * The open AskUserQuestion in a session's events, or null.
 *
 * Claude's panel shows ONE question at a time (the tool can carry a questions array, but the UI is
 * single-panel), so the LAST AskUserQuestion tool_use without a matching tool_result -- scanned in
 * event order across the durable buffer and the live tail -- is the open one. A tool_result for its
 * callId closes it: the answer (or skip) was recorded, so the mirror must go away even if the host
 * has not yet observed the panel closing.
 *
 * Pure so it is unit-testable without any bridge; the feed mirrors the result up to the shell.
 * `events` is the stream's sorted event array; `liveTails` are the streamed rows the transcript has
 * not reached yet, which may duplicate a durable event while the stream is in flight -- harmless,
 * since the parse is idempotent per callId.
 */
export function openAskUserQuestion(
  events: readonly ActivityEvent[],
  liveTails: readonly ActivityEvent[],
): OpenAskUserQuestion | null {
  const ordered = [...events, ...liveTails];
  let question: OpenAskUserQuestion | null = null;
  const answered = new Set<string>();
  for (const event of ordered) {
    for (const block of event.blocks) {
      if (block.kind === "tool_use" && block.tool === "AskUserQuestion") {
        const parsed = parseAskUserQuestion(block.callId, block.input);
        if (parsed) question = parsed;
      } else if (block.kind === "tool_result" && block.callId) {
        answered.add(block.callId);
      }
    }
  }
  return question && !answered.has(question.callId) ? question : null;
}

/**
 * Parses one AskUserQuestion tool_use block into the mirror's content shape.
 *
 * EVERY question, in the call's own order, because the order is what the answers are matched by on
 * the way back out. A block that yields no usable question at all is null so it never surfaces as
 * a mirror; one unusable question among several is dropped, which would put every answer after it
 * against the wrong question -- so that case is null too.
 */
export function parseAskUserQuestion(
  callId: string | undefined,
  input: Record<string, unknown> | undefined,
): OpenAskUserQuestion | null {
  if (!callId) return null;
  const rawQuestions = input?.questions;
  if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) return null;
  const questions: AskUserQuestionItem[] = [];
  for (const raw of rawQuestions) {
    const question = parseQuestion(raw);
    // All or nothing. A mirror missing question three would send three answers for four tabs, and
    // the dialog would take them in order against the wrong questions.
    if (!question) return null;
    questions.push(question);
  }
  return { callId, questions };
}

function parseQuestion(raw: unknown): AskUserQuestionItem | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const question = raw as Record<string, unknown>;
  const text = typeof question.question === "string" ? question.question.trim() : "";
  if (!text) return null;
  const options: AskUserQuestionOption[] = [];
  if (Array.isArray(question.options)) {
    for (const entry of question.options) {
      const option = parseOption(entry);
      if (option) options.push(option);
    }
  }
  if (options.length === 0) return null;
  const header = typeof question.header === "string" ? question.header.trim() : "";
  return {
    question: text,
    ...(header ? { header } : {}),
    multiSelect: question.multiSelect === true,
    options,
  };
}

function parseOption(raw: unknown): AskUserQuestionOption | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const entry = raw as Record<string, unknown>;
  const label = entry.label;
  if (typeof label !== "string" || !label.trim()) return null;
  const description = entry.description;
  const preview = entry.preview;
  return {
    label: label.trim(),
    ...(typeof description === "string" && description.trim()
      ? { description: description.trim() }
      : {}),
    // Kept as written, newlines and all: a preview is a small diagram and trimming its interior
    // would take its shape away.
    ...(typeof preview === "string" && preview.trim() ? { preview } : {}),
  };
}
