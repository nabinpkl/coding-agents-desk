// What an ask_owner call and its answers must look like before the sidecar holds or delivers them.
//
// Pure, so every rule is tested without a server. A call comes from the process serving the tool,
// which passes on what the model wrote, so it is checked as untrusted input: bounded everywhere,
// labels unique within a question (an answer names its option by label), ids unique within a call
// (the answers come back keyed by them). Answers come from the panel and are checked against the
// call they answer, so a session is never handed a choice it did not offer.

import {
  ASK_OWNER_MAX_QUESTIONS,
  type AskOwnerAnswer,
  type AskOwnerCall,
  type AskOwnerChoice,
  type AskOwnerOption,
  type AskOwnerQuestion,
  type WaitAskOwnerCommand,
} from "@agentdesk/agent-feed-wire";

const KINDS = new Set(["single", "multi", "text"]);
const SOURCES = new Set(["claude", "opencode"]);
const TOOL_USE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SESSION_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const QUESTION_ID = /^[A-Za-z0-9_-]{1,40}$/;
const MAX_OPTIONS = 8;

/** The longest each piece of text may be, in characters. */
const LIMITS = {
  question: 2_000,
  header: 40,
  label: 200,
  description: 1_000,
  preview: 4_000,
  noteLabel: 80,
  placeholder: 200,
  note: 4_000,
  text: 8_000,
} as const;

type Checked<T> = { ok: true; value: T } | { ok: false; message: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A required string, trimmed, non-empty and within its limit; or why not. */
function text(value: unknown, field: string, limit: number): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${field} must be a non-empty string`);
  if (value.length > limit) throw new Error(`${field} is longer than ${limit} characters`);
  return value.trim();
}

/** An optional string: absent, or one `text` accepts. An empty one counts as absent. */
function optional(value: unknown, field: string, limit: number): string | undefined {
  if (value === undefined || (typeof value === "string" && value.trim().length === 0)) return undefined;
  return text(value, field, limit);
}

function option(raw: unknown, field: string): AskOwnerOption {
  if (!isRecord(raw)) throw new Error(`${field} must be an object`);
  const description = optional(raw.description, `${field}.description`, LIMITS.description);
  // Kept as written, newlines and inner spacing included: a preview is a small diagram.
  const preview = optional(raw.preview, `${field}.preview`, LIMITS.preview) === undefined ? undefined : raw.preview;
  const noteLabel = optional(raw.noteLabel, `${field}.noteLabel`, LIMITS.noteLabel);
  return {
    label: text(raw.label, `${field}.label`, LIMITS.label),
    ...(description ? { description } : {}),
    ...(typeof preview === "string" ? { preview } : {}),
    ...(noteLabel ? { noteLabel } : {}),
  };
}

function question(raw: unknown, field: string): AskOwnerQuestion {
  if (!isRecord(raw)) throw new Error(`${field} must be an object`);
  if (typeof raw.id !== "string" || !QUESTION_ID.test(raw.id)) {
    throw new Error(`${field}.id must be 1 to 40 letters, digits, "_" or "-"`);
  }
  if (typeof raw.kind !== "string" || !KINDS.has(raw.kind)) {
    throw new Error(`${field}.kind must be "single", "multi" or "text"`);
  }
  const kind = raw.kind as AskOwnerQuestion["kind"];
  const rawOptions = raw.options ?? [];
  if (!Array.isArray(rawOptions)) throw new Error(`${field}.options must be a list`);
  if (kind === "text" && rawOptions.length > 0) throw new Error(`${field} is answered in words and takes no options`);
  if (kind !== "text" && (rawOptions.length < 2 || rawOptions.length > MAX_OPTIONS)) {
    throw new Error(`${field} needs 2 to ${MAX_OPTIONS} options`);
  }
  const options = rawOptions.map((each, at) => option(each, `${field}.options[${at}]`));
  const labels = new Set(options.map((each) => each.label));
  if (labels.size !== options.length) throw new Error(`${field} has two options with one label`);
  const header = optional(raw.header, `${field}.header`, LIMITS.header);
  const placeholder = optional(raw.placeholder, `${field}.placeholder`, LIMITS.placeholder);
  return {
    id: raw.id,
    question: text(raw.question, `${field}.question`, LIMITS.question),
    ...(header ? { header } : {}),
    kind,
    options,
    ...(placeholder ? { placeholder } : {}),
  };
}

/** The call the serving process says is waiting, checked, or why it was refused. */
export function readWaitCommand(raw: unknown): Checked<WaitAskOwnerCommand> {
  try {
    if (!isRecord(raw)) throw new Error("the body must be an object");
    if (typeof raw.toolUseId !== "string" || !TOOL_USE_ID.test(raw.toolUseId)) throw new Error("toolUseId is not one");
    if (typeof raw.source !== "string" || !SOURCES.has(raw.source))
      throw new Error("source must be claude or opencode");
    if (typeof raw.sessionId !== "string" || !SESSION_ID.test(raw.sessionId)) throw new Error("sessionId is not one");
    if (!Array.isArray(raw.questions) || raw.questions.length === 0)
      throw new Error("questions must be a non-empty list");
    if (raw.questions.length > ASK_OWNER_MAX_QUESTIONS) {
      throw new Error(`a call asks at most ${ASK_OWNER_MAX_QUESTIONS} questions`);
    }
    const questions = raw.questions.map((each, at) => question(each, `questions[${at}]`));
    if (new Set(questions.map((each) => each.id)).size !== questions.length) {
      throw new Error("two questions share one id");
    }
    return {
      ok: true,
      value: {
        toolUseId: raw.toolUseId,
        source: raw.source as WaitAskOwnerCommand["source"],
        sessionId: raw.sessionId,
        questions,
      },
    };
  } catch (error) {
    return { ok: false, message: (error as Error).message };
  }
}

function choice(raw: unknown, asked: AskOwnerQuestion, field: string): AskOwnerChoice {
  if (!isRecord(raw)) throw new Error(`${field} must be an object`);
  const label = text(raw.label, `${field}.label`, LIMITS.label);
  if (!asked.options.some((each) => each.label === label)) {
    throw new Error(`"${label}" is not an option of "${asked.question}"`);
  }
  const note = optional(raw.note, `${field}.note`, LIMITS.note);
  return { label, ...(note ? { note } : {}) };
}

/**
 * The panel's answers, checked against the call they answer: one per question in its order, every
 * choice one the question offered, at most one on a "single" question, and something said for each.
 */
export function readAnswers(raw: unknown, call: AskOwnerCall): Checked<AskOwnerAnswer[]> {
  try {
    if (!Array.isArray(raw)) throw new Error("answers must be a list");
    if (raw.length !== call.questions.length) {
      throw new Error(`the call asks ${call.questions.length} questions and ${raw.length} answers came`);
    }
    const answers = call.questions.map((asked, at): AskOwnerAnswer => {
      const entry: unknown = raw[at];
      const field = `answers[${at}]`;
      if (!isRecord(entry)) throw new Error(`${field} must be an object`);
      if (entry.id !== asked.id) throw new Error(`${field} answers "${String(entry.id)}", not "${asked.id}"`);
      const rawChosen = entry.chosen ?? [];
      if (!Array.isArray(rawChosen)) throw new Error(`${field}.chosen must be a list`);
      if (asked.kind === "text" && rawChosen.length > 0) throw new Error(`"${asked.question}" offers no options`);
      const chosen = rawChosen.map((each, index) => choice(each, asked, `${field}.chosen[${index}]`));
      if (new Set(chosen.map((each) => each.label)).size !== chosen.length) {
        throw new Error(`${field} chooses one option twice`);
      }
      if (asked.kind === "single" && chosen.length > 1) throw new Error(`"${asked.question}" takes one option`);
      const words = optional(entry.text, `${field}.text`, LIMITS.text);
      if (chosen.length === 0 && !words) throw new Error(`"${asked.question}" has no answer`);
      return { id: asked.id, chosen, ...(words ? { text: words } : {}) };
    });
    return { ok: true, value: answers };
  } catch (error) {
    return { ok: false, message: (error as Error).message };
  }
}
