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
  /** The tool_use id. What answering sends back against, and one of the three things that close
   *  this question -- see `openAskUserQuestion`, which owns the other two. */
  callId: string;
  /**
   * Every question the call carries, in its own order.
   *
   * All of them, not the first. This used to take `questions[0]` because the surface it mirrored
   * was Claude Desktop's single panel; the terminal draws one tab per question and refuses to
   * submit until each has an answer, so answering only the first there finishes nothing.
   */
  questions: AskUserQuestionItem[];
  /**
   * Present when this was read off the session's terminal rather than from its tool call
   * (`questionFromPane`), with how many of the call's other questions the screen could not show.
   */
  pane?: { unseen: number };
}

/**
 * The open AskUserQuestion in a session's events, or null.
 *
 * The LAST AskUserQuestion tool_use that nothing after it has closed, scanned in event order
 * across the durable buffer and then the live tail.
 *
 * Three things close one, and the second and third exist because the CLI does NOT always write a
 * result. Measured 2026-09-15 across 189 calls in this machine's transcripts: 188 were answered
 * and carry a `tool_result`, and the one that was not carries nothing at all. Its session simply
 * moved on -- the person typed an ordinary message instead of answering, the terminal dropped its
 * dialog, and the turn continued. On the rule this used to apply ("open until a tool_result with
 * that callId"), that mirror stayed up for the life of the session with the transcript scrolling
 * past behind it, which is exactly what it looked like on screen.
 *
 * - **Its `tool_result`.** The answer, or the skip, was recorded.
 * - **A human turn.** A person cannot type a message into a terminal whose dialog is holding the
 *   composer, so a message recorded after the question is a message that dismissed it.
 *   `humanTurn` rather than `type === "user"`: a tool result is a user line too, and results for
 *   the OTHER calls of a parallel batch legitimately arrive while this one is still open.
 * - **The turn moving on**, which is a later event carrying a different `messageId`. The API
 *   blocks until every tool call of a message has a result, so another message existing is proof
 *   this one was let go. Compared by message rather than by position because a call batched
 *   alongside this one writes its own line from the SAME message, and that is not the turn moving
 *   anywhere. The narrow case it can still read wrong is an old transcript that keeps a
 *   subagent's lines inline; a sidechain message landing here would hide a question the terminal
 *   is still showing, which is a mirror to reopen rather than an answer sent anywhere.
 *
 * Only the first of the three is read off the live tail. The tail IS the turn that asked -- the
 * mirror runs ahead of the file and publishes the very message the question came in -- so nothing
 * in it can be evidence that the turn moved past its own question.
 *
 * Pure so it is unit-testable without any bridge; the feed mirrors the result up to the shell.
 * `events` is the stream's sorted event array; `liveTails` are the streamed rows the transcript
 * has not reached yet, which may duplicate a durable event while the stream is in flight --
 * harmless, since the parse is idempotent per callId and a closed call is not reopened by one.
 */
export function openAskUserQuestion(
  events: readonly ActivityEvent[],
  liveTails: readonly ActivityEvent[],
): OpenAskUserQuestion | null {
  // Every call this scan has already closed, so a duplicate of the asking row arriving later on
  // the live tail cannot put a finished question back on screen.
  const closed = new Set<string>();
  let open: OpenQuestion | null = null;
  for (const event of events) open = consider(event, open, closed, false);
  for (const event of liveTails) open = consider(event, open, closed, true);
  return open?.question ?? null;
}

/** What one event does to the question that was open when it arrived. */
function consider(
  event: ActivityEvent,
  open: OpenQuestion | null,
  closed: Set<string>,
  live: boolean,
): OpenQuestion | null {
  let next = open;
  if (next && closesQuestion(event, next, live)) {
    closed.add(next.question.callId);
    next = null;
  }
  for (const block of event.blocks) {
    if (block.kind !== "tool_use" || block.tool !== "AskUserQuestion") continue;
    const parsed = parseAskUserQuestion(block.callId, block.input);
    if (parsed && !closed.has(parsed.callId)) {
      next = { question: parsed, messageId: event.messageId };
    }
  }
  return next;
}

/** An open question and the message it was asked in, which is what "the turn moved on" is against. */
interface OpenQuestion {
  question: OpenAskUserQuestion;
  messageId: string | undefined;
}

function closesQuestion(event: ActivityEvent, open: OpenQuestion, live: boolean): boolean {
  for (const block of event.blocks) {
    if (block.kind === "tool_result" && block.callId === open.question.callId) return true;
  }
  if (live) return false;
  if (event.humanTurn === true) return true;
  return event.messageId !== undefined && open.messageId !== undefined && event.messageId !== open.messageId;
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
    ...(typeof description === "string" && description.trim() ? { description: description.trim() } : {}),
    // Kept as written, newlines and all: a preview is a small diagram and trimming its interior
    // would take its shape away.
    ...(typeof preview === "string" && preview.trim() ? { preview } : {}),
  };
}
