// The vocabulary the composer coordinator and its parts share: what a session key is,
// what a failure is called, and what counts as a status worth telling a watcher about.

import type {
  WindowComposerEnvelope,
  WindowComposerStatus,
  WindowInputReason,
  WindowQuestionAction,
  WindowQuestionStatus,
} from "@agentdesk/agent-feed-wire";

// The status shapes live in `agent-feed/wire/desktopWindow.ts`, not here: they cross the HTTP
// boundary to the panel, and the wire module is the single declaration for everything that does.
export type ComposerStatus = WindowComposerStatus;
export type QuestionStatus = WindowQuestionStatus;
export type ComposerEnvelope = WindowComposerEnvelope;
export type QuestionAction = WindowQuestionAction;

/**
 * One line per composer event that moved a window or refused to.
 *
 * The Swift path this replaced logged every move-in, move-back, and unverified move to the host's
 * unified log; the port arrived with no diagnostics at all, so the first real failure had to be
 * diagnosed from a screenshot. Same `console.log(JSON.stringify(...))` shape as the catalog, which
 * means it lands in the host's `agent-feed-sidecar` category and greps beside everything else.
 *
 * Only failures and window movement. A per-poll line would bury them.
 */
export function logComposer(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ event: `agent-feed-composer-${event}`, ...fields }));
}

/** A failure carrying a code the panel maps to a sentence. */
export class ComposerError extends Error {
  constructor(readonly reason: WindowInputReason) {
    super(`composer request failed: ${reason}`);
    this.name = "ComposerError";
  }
}

/**
 * Which application owns a session's window.
 *
 * Carried alongside the id rather than inferred, because the two resolvers answer different
 * questions: Claude's is the process tree, Codex's is the app's own state joined to its accessibility
 * tree. Nothing downstream guesses which one to run.
 */
export type WindowSource = "claude" | "codex";

/** A session, and the application whose window shows it. */
export interface SessionKey {
  source: WindowSource;
  sessionId: string;
}

export function keyOf(key: SessionKey): string {
  return `${key.source}:${key.sessionId}`;
}

export interface Subscription {
  source: WindowSource;
  sessionId: string;
  emit: (envelope: ComposerEnvelope) => void;
  lastComposer: ComposerStatus | null;
  lastQuestion: QuestionStatus | null;
}

/**
 * A helper reason string as a wire code.
 *
 * The helper only ever emits codes from the same union, but it is a separate process built from a
 * separate file, so an unknown string degrades to `helper-unavailable` rather than being trusted
 * into the type.
 */
export function asReason(reason: string): WindowInputReason {
  return KNOWN_REASONS.has(reason) ? (reason as WindowInputReason) : "helper-unavailable";
}

export function unavailableQuestion(sessionId: string, reason: WindowInputReason): QuestionStatus {
  return {
    sessionId,
    enabled: false,
    reason,
    present: false,
    selectedIndices: [],
    otherText: null,
    submitEnabled: null,
  };
}

const KNOWN_REASONS = new Set<string>([
  "not-running",
  "terminal-only",
  "multiple-instances",
  "no-window",
  "ax-denied",
  "composer-missing",
  "move-failed",
  "restore-failed",
  "window-mover-unavailable",
  "write-failed",
  "verify-mismatch",
  "placement-unavailable",
  "focus-stolen",
  "ambiguous-window",
  "question-missing",
  "helper-unavailable",
]);

export function sameComposer(a: ComposerStatus | null, b: ComposerStatus): boolean {
  return (
    a !== null &&
    a.enabled === b.enabled &&
    a.reason === b.reason &&
    a.onActiveDesktop === b.onActiveDesktop &&
    a.composerText === b.composerText
  );
}

export function sameQuestion(a: QuestionStatus | null, b: QuestionStatus): boolean {
  return (
    a !== null &&
    a.enabled === b.enabled &&
    a.reason === b.reason &&
    a.present === b.present &&
    a.otherText === b.otherText &&
    a.submitEnabled === b.submitEnabled &&
    a.selectedIndices.length === b.selectedIndices.length &&
    a.selectedIndices.every((value, index) => value === b.selectedIndices[index])
  );
}
