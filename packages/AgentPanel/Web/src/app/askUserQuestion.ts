import type { ActivityEvent } from "../features/activity-feed/useSessionEventsStream";

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
}

export interface OpenAskUserQuestion {
  /** The tool_use id; the matching tool_result closes the question. */
  callId: string;
  question: string;
  header?: string;
  multiSelect: boolean;
  options: AskUserQuestionOption[];
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
 * `events` is the stream's sorted event array; `liveTail` is the latest streamed event, which may
 * duplicate a durable event while the stream is in flight -- harmless, since the parse is
 * idempotent per callId.
 */
export function openAskUserQuestion(
  events: readonly ActivityEvent[],
  liveTail: ActivityEvent | null,
): OpenAskUserQuestion | null {
  const ordered = [...events, ...(liveTail ? [liveTail] : [])];
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
 * Only the FIRST question in the array is used, matching Claude's single-panel UI. An unusable block
 * (no callId, no question text, no usable options) yields null so it never surfaces as a mirror.
 */
export function parseAskUserQuestion(
  callId: string | undefined,
  input: Record<string, unknown> | undefined,
): OpenAskUserQuestion | null {
  if (!callId) return null;
  const rawQuestions = input?.questions;
  if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) return null;
  const first = rawQuestions[0];
  if (!first || typeof first !== "object" || Array.isArray(first)) return null;
  const question = first as Record<string, unknown>;
  const text = typeof question.question === "string" ? question.question.trim() : "";
  if (!text) return null;
  const options: AskUserQuestionOption[] = [];
  if (Array.isArray(question.options)) {
    for (const raw of question.options) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const label = (raw as Record<string, unknown>).label;
      if (typeof label !== "string" || !label.trim()) continue;
      const description = (raw as Record<string, unknown>).description;
      options.push({
        label: label.trim(),
        ...(typeof description === "string" && description.trim()
          ? { description: description.trim() }
          : {}),
      });
    }
  }
  if (options.length === 0) return null;
  const header = typeof question.header === "string" ? question.header.trim() : "";
  return {
    callId,
    question: text,
    ...(header ? { header } : {}),
    multiSelect: question.multiSelect === true,
    options,
  };
}
