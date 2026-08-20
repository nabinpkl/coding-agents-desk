// A digest of one turn: what the agent did between the last user message and now.
//
// Produced on demand by a SECOND model, not by the session being summarized, and produced from
// the TRANSCRIPT ALONE. It opens no files and runs no commands. The first version did -- it had
// read-only tools and was told to verify the agent's claims against the checkout -- and it was
// slow enough that people stopped pressing the button: a minute of tool round trips to confirm
// things the transcript had already said. Reading one well-shaped transcript is a single model
// call, and the transcript is where the answer was.
//
// Deliberately one shape for both timings. Pressing the button mid-turn and pressing it after
// the turn ends produce the same artifact; only `phase` differs. There is no separate live
// mode, and adding one later means adding a transport, not a second type.

import type { EventMode } from "./activity.ts";
import type { AgentRunState } from "./session.ts";

/**
 * Whether the turn was still going when this digest was produced.
 *
 * `running` is not a lesser result. It is the answer to "what is it doing right now", which is
 * the question a viewer has while a turn is in flight, and it is honest about being a snapshot
 * of something still moving.
 */
export type SummaryPhase = "running" | "final";

/** What the turn did to a file, as its own tool calls record it. */
export type SummaryFileAction = "wrote" | "edited" | "deleted";

/**
 * One file the turn changed, read from the turn's own tool calls.
 *
 * From the transcript rather than from `git diff`, and the difference is attribution. The
 * working tree is the state of the checkout right now: it carries what other sessions and the
 * person did before and since, so a digest built on it confidently described another session's
 * uncommitted work as this turn's. A turn's own Write and Edit calls are unambiguously the
 * turn's. The cost is honest and worth naming: an edit the agent later reverted still appears
 * here, and a file changed by a build the agent ran does not appear at all. This says what the
 * turn DID, not what the checkout now holds.
 */
export interface SummaryFileChange {
  path: string;
  action: SummaryFileAction;
  /** How many separate calls in this turn touched it. Three edits to one file is a different
   *  story from one, and it is the shape of an agent going back and forth. */
  edits: number;
  /** Lines added and removed, counted from the edit payloads themselves. Zero for a call whose
   *  payload does not say -- an `apply_patch` that named only a path, for instance. */
  added: number;
  removed: number;
}

/**
 * Which events the digest actually saw.
 *
 * `truncated` is load-bearing and must never be quietly false. A long turn does not fit the
 * summarizer's context, so the middle of the slice is dropped; a digest that hid that fact
 * would read as complete while missing the part the viewer cares about. Indices are
 * mode-relative, so `mode` travels with them.
 */
export interface SummaryCoverage {
  fromEventIndex: number;
  toEventIndex: number;
  mode: EventMode;
  truncated: boolean;
}

/**
 * What the summary stream says while it works.
 *
 * The digest takes long enough to write that a spinner for it is indistinguishable from a hang.
 * This is the same reasoning the finished `SummaryResult` carries, sent as it happens, so the
 * wait shows the work instead of hiding it.
 *
 * `thinking-delta` is the model's reasoning arriving in pieces, appended to the thought in
 * progress; the `reasoning` message that follows carries the same block assembled and REPLACES
 * what the deltas built, so a reader never has to reconcile two versions of one thought. Exactly
 * one `result` or one `error` ends the stream.
 */
export type SummaryStreamMessage =
  | { type: "reasoning"; text: string }
  | { type: "thinking-delta"; text: string }
  | { type: "result"; result: SummaryResult }
  | { type: "error"; error: { code: string; message: string; retryable: boolean } };

export interface SummaryResult {
  phase: SummaryPhase;
  /** Epoch ms the digest was produced, not the timestamp of any event in it. */
  generatedAt: number;
  /** Which model produced it. Named on the artifact because the summarizer's model is
   *  configurable and a digest is only as trustworthy as the thing that wrote it. */
  model: string;
  headline: string;
  narrative: string;
  filesTouched: SummaryFileChange[];
  /** What the summarizer thinks is unfinished or wrong. Empty is a real answer. */
  risks: string[];
  /**
   * The summarizer's own reasoning blocks, in order.
   *
   * A digest is a claim about someone else's work written by a model, and this is the only thing
   * that makes the claim checkable: what it noticed, what it weighed, where it hedged. Empty
   * when the model's reasoning was not visible, which a non-reasoning model gives.
   */
  reasoning: string[];
  coverage: SummaryCoverage;
  /** The watched session's run state at the moment the digest was produced. */
  runState: AgentRunState;
}
