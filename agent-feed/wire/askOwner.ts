// ask_owner: a question tool of ours, served to a Claude session by a mod, that a session uses when
// it is told to ask the owner. The panel draws it and answers it; the session waits on the answer.
//
// Not Claude's AskUserQuestion. That tool's shape is Claude Code's (at most four questions, no note
// on an option) and a terminal session answers it through keystrokes into its dialog. This one is
// ours end to end, so it carries up to five questions, a note on any chosen option, and questions
// answered in words alone, and it is answered by the sidecar handing the answers to the waiting call.
//
// Keyed by the tool call's own id, which the call carries (`claudecode/toolUseId`, measured
// 2026-10-21): the same id as the transcript's tool_use row, so nothing is matched by its text.
// Whether one is still waiting is the sidecar's to say and never the transcript's: a call still
// running after two minutes is moved to the background, and the transcript records a tool_result
// for it then, long before anybody has answered.

import type { SourceId } from "./activity.ts";

/** At most this many questions in one call. */
export const ASK_OWNER_MAX_QUESTIONS = 5;

/**
 * How a question is answered: one option, any of them, or in words. A "text" question has no
 * options; the other two may also be answered in words, as "something else".
 */
export type AskOwnerQuestionKind = "single" | "multi" | "text";

export interface AskOwnerOption {
  label: string;
  description?: string;
  /** A small diagram or snippet, kept preformatted. */
  preview?: string;
  /**
   * What the session wants to hear about this option if it is chosen, such as "Why?". A note can
   * be added to any chosen option; this only asks for one. Never required.
   */
  noteLabel?: string;
}

export interface AskOwnerQuestion {
  /** The key the answer comes back under. Unique within the call. */
  id: string;
  question: string;
  /** A short label for the question's tab. */
  header?: string;
  kind: AskOwnerQuestionKind;
  /** Empty for a "text" question. */
  options: AskOwnerOption[];
  /** What the answer field shows while it is empty. */
  placeholder?: string;
}

/** One ask_owner call that is waiting for its answers. */
export interface AskOwnerCall {
  toolUseId: string;
  source: SourceId;
  sessionId: string;
  questions: AskOwnerQuestion[];
  /** Epoch milliseconds. */
  askedAt: number;
}

/** One chosen option, by its label, and the note written on it. */
export interface AskOwnerChoice {
  label: string;
  note?: string;
}

/**
 * The answer to one question. A "single" question has at most one choice; any question may carry
 * words instead of, or beside, its choices.
 */
export interface AskOwnerAnswer {
  id: string;
  chosen: AskOwnerChoice[];
  text?: string;
}

/**
 * `GET /api/sessions/{source}/{sessionId}/asks/stream`: every ask_owner call of this session that
 * is waiting, oldest first, sent whole on opening and again on every change. Empty when none is.
 */
export interface AskOwnerStreamMessage {
  asks: AskOwnerCall[];
}

/**
 * `POST /api/sessions/{source}/{sessionId}/asks/{toolUseId}/answer`: the answers to every question
 * of the call, in its order.
 */
export interface AnswerAskOwnerCommand {
  answers: AskOwnerAnswer[];
}

/**
 * Why answers did not reach the call:
 * - "not-waiting": nothing is waiting under that id, because it was answered, dismissed, or its
 *   session ended.
 * - "wrong-answers": they do not fit the call's questions; the message names the first misfit.
 */
export type AskOwnerRefusal = "not-waiting" | "wrong-answers";

/**
 * What answering, or dismissing, came to. A dismissal is
 * `POST /api/sessions/{source}/{sessionId}/asks/{toolUseId}/dismiss`, and the session is told that
 * the owner closed the questions without answering.
 */
export type AskOwnerOutcome = { delivered: true } | { delivered: false; reason: AskOwnerRefusal; message: string };

/**
 * `POST /api/asks`, from the process serving the tool to a session: this call is waiting. The
 * response is a stream that carries one `AskOwnerVerdict` and ends, with heartbeats until then.
 * Sent again under the same id after a sidecar restart, and a call whose every waiting request has
 * gone is no longer waiting: its session ended, or its tool call was cancelled.
 */
export type WaitAskOwnerCommand = Omit<AskOwnerCall, "askedAt">;

/** How a waiting call ended: answered, or closed by the owner without an answer. */
export type AskOwnerVerdict = { answered: AskOwnerAnswer[] } | { dismissed: true };
