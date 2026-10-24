// A Claude session run through the Agent SDK instead of the terminal UI (ADR-0143).
//
// The session is the same session either way: one transcript, one id, one registry row while it
// runs. What differs is who holds the `claude` process. In terminal mode it is the TUI in a tmux
// pane; in SDK mode it is a small runner in that same pane, holding one long-lived `query()`, and
// the sidecar reaches it over a unix socket. Questions and approvals arrive there as data rather
// than as a dialog drawn on a screen, which is the point.
//
// The runner, not the sidecar, holds everything that is waiting -- a question, an approval -- so a
// sidecar restart loses nothing: the next connection is handed the whole state again.

import type { ClaudePermissionMode } from "./tmuxComposer.ts";
import type { TmuxQuestionAnswer, TmuxQuestionOutcome } from "./tmuxQuestion.ts";

/**
 * How a Claude session's process is run, chosen at creation. A start that names none gets the
 * terminal; the panel's new-session dialog names SDK, which is the current path.
 */
export type ClaudeRunMode = "terminal" | "sdk";

/** How much Claude thinks before answering, in the SDK's names for the levels, least first. */
export type ClaudeEffortLevel = "low" | "medium" | "high" | "xhigh" | "max";
export const CLAUDE_EFFORT_LEVELS: readonly ClaudeEffortLevel[] = ["low", "medium", "high", "xhigh", "max"];

/** What the runner says its `claude` is doing, from the SDK's own session-state messages. */
export type ClaudeSdkRunStatus = "starting" | "idle" | "running" | "requires-action" | "exited";

/** One AskUserQuestion question, as the tool call carries it. */
export interface ClaudeSdkQuestion {
  question: string;
  header: string;
  multiSelect: boolean;
  options: { label: string; description: string }[];
}

/** An AskUserQuestion call the runner is holding open until somebody answers it. */
export interface ClaudeSdkQuestionRequest {
  kind: "question";
  toolUseId: string;
  questions: ClaudeSdkQuestion[];
  /** Epoch ms the call reached the runner. */
  openedAt: number;
}

/**
 * A tool call the session's permission mode did not settle on its own.
 *
 * The descriptive fields are the CLI's own wording for the prompt it would have drawn, passed
 * through rather than rebuilt here, so the card says what the terminal would have said.
 */
export interface ClaudeSdkApprovalRequest {
  kind: "approval";
  toolUseId: string;
  toolName: string;
  /** The tool's input, as the model sent it. */
  input: Record<string, unknown>;
  /** The full prompt sentence, e.g. "Claude wants to read foo.txt". */
  title?: string;
  /** A short noun phrase for the action, e.g. "Read file". */
  displayName?: string;
  /** A subtitle saying what allowing it grants. */
  description?: string;
  /** Why the mode asked rather than deciding. */
  decisionReason?: string;
  /** The path outside the allowed directories that triggered it, when that is the reason. */
  blockedPath?: string;
  /** The CLI asks that this not be approvable by one stray press. */
  defaultToNo?: boolean;
  openedAt: number;
}

export type ClaudeSdkPendingRequest = ClaudeSdkQuestionRequest | ClaudeSdkApprovalRequest;

/**
 * Everything the runner knows that the transcript does not, sent whole on every change.
 *
 * Whole rather than as deltas because it is small -- a status, a mode and the handful of calls
 * waiting -- and a reader that missed a delta would hold a pending request that was long gone.
 */
export interface ClaudeSdkSessionState {
  /** False while the sidecar cannot reach a runner for this session; the rest is then empty. */
  connected: boolean;
  status: ClaudeSdkRunStatus;
  /** null until the CLI has said which mode it is in. */
  permissionMode: ClaudePermissionMode | null;
  /** Whether bypass permissions may be switched to, as the launch decided. */
  allowBypass: boolean;
  pending: ClaudeSdkPendingRequest[];
  /** Background shells and agents running inside this `claude`, which die with it. */
  backgroundTasks: number;
  /** The CLI version the runner's `claude` reported at start, when it has. */
  claudeCodeVersion: string | null;
  /**
   * The CLI version the sidecar's Agent SDK was built for, when `claudeCodeVersion` is older than
   * it; null when it is not, or either is unknown. The panel says so, since an older CLI may not
   * understand what the library sends.
   */
  claudeCodeNeeded: string | null;
  /** The model the session is answering with, as the CLI names it (`claude-opus-5-5`), once known. */
  model: string | null;
  /** The models this `claude` offers, from the SDK's `supportedModels()`; empty until it answers. */
  models: ClaudeSdkModel[];
  /**
   * Prompts the person sent while a turn was running, oldest first, that the session has not been
   * seen to take in yet. The CLI says nothing when it folds one into the running turn or starts the
   * next turn with it, so each is held until that turn ends; the panel also drops one the moment
   * the transcript shows it.
   */
  queued: ClaudeSdkQueuedPrompt[];
  /**
   * The effort the session sends on its next request: the level chosen here, or the CLI's own word
   * on it (`getSettings().applied`, or its init where it names one); null while nothing has said.
   */
  effort: ClaudeEffortLevel | null;
  /**
   * Claude's guess at what the person will say next, which the terminal draws faint in its empty
   * box; null when it is offering none. The CLI sends one after some turns' results, its own call
   * which (never after the first, nor in plan mode), and it stops being an offer the moment
   * anything is sent or the session starts working again.
   */
  suggestion: string | null;
}

/** A prompt sent to an SDK session while it was busy, as the feed shows it until it is taken in. */
export interface ClaudeSdkQueuedPrompt {
  id: string;
  text: string;
  /** How many images rode with it. */
  images: number;
  /** Epoch ms the sidecar sent it. */
  sentAt: number;
}

/** One model the session can be switched to. */
export interface ClaudeSdkModel {
  /** What `setModel` takes: an alias (`opus`) or a full id. */
  value: string;
  /** The full model id an alias stands for, which is how the current model is matched to its row. */
  resolvedModel?: string;
  displayName: string;
  description: string;
  /** The effort levels this model takes; absent for a model without effort. */
  effortLevels?: ClaudeEffortLevel[];
}

/** Switch the model a session answers with, from its next turn. */
export interface ClaudeSdkModelCommand {
  model: string;
}

/** Set how much the session thinks, from its next request. */
export interface ClaudeSdkEffortCommand {
  effort: ClaudeEffortLevel;
}

/** The state a reader holds before a runner has answered, and after one is gone. */
export const DISCONNECTED_CLAUDE_SDK_STATE: ClaudeSdkSessionState = {
  connected: false,
  status: "exited",
  permissionMode: null,
  allowBypass: false,
  pending: [],
  backgroundTasks: 0,
  claudeCodeVersion: null,
  claudeCodeNeeded: null,
  model: null,
  models: [],
  queued: [],
  effort: null,
  suggestion: null,
};

/** A turn typed into an SDK session. */
export interface ClaudeSdkPromptCommand {
  text: string;
}

/**
 * The answers to one open AskUserQuestion call.
 *
 * The same shape the terminal's dialog takes, so the panel drafts one answer whichever mode the
 * session runs in. The runner matches it against the call it is holding by the questions' text.
 */
export interface ClaudeSdkAnswerCommand {
  answers: TmuxQuestionAnswer[];
}

/** Allow or deny one pending approval, by its tool-use id. */
export interface ClaudeSdkDecideCommand {
  toolUseId: string;
  allow: boolean;
  /** Said to the model on a deny, so it knows why and does not simply try again. */
  message?: string;
}

export interface ClaudeSdkModeCommand {
  mode: ClaudePermissionMode;
}

/** Why a command to an SDK session did not happen. */
export type ClaudeSdkRefusal =
  /** No runner is answering for this session: it is not in SDK mode, or not running. */
  | "no-runner"
  /** The request it names is no longer waiting: answered elsewhere, or the turn moved on. */
  | "not-pending"
  /** The body did not describe a command. */
  | "invalid"
  /** The runner took the command and the SDK refused it. */
  | "failed";

export type ClaudeSdkCommandOutcome = { ok: true } | { ok: false; reason: ClaudeSdkRefusal; message: string };

/**
 * An answer's outcome, in the terminal dialog's shape so the panel's question band reads both.
 *
 * The SDK path cannot half-answer -- the runner resolves the call with every answer or with none --
 * so `sent` is always false on a refusal, and the typed text always comes back.
 */
export type ClaudeSdkAnswerOutcome = TmuxQuestionOutcome;

/** Move a running session to the other mode, while it is idle (ADR-0143). */
export interface ClaudeSdkSwitchCommand {
  mode: ClaudeRunMode;
}

/** Why a session was not moved; the message says it in the reader's terms. */
export type ClaudeSdkSwitchRefusal =
  | "not-running"
  | "several-processes"
  | "not-ours"
  | "already"
  | "busy"
  | "invalid"
  | "failed";

export type ClaudeSdkSwitchOutcome = { ok: true } | { ok: false; reason: ClaudeSdkSwitchRefusal; message: string };
