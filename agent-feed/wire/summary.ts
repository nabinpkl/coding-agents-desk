// A digest of one turn: what the agent did between the last user message and now.
//
// Produced on demand by a SECOND agent, not by the session being summarized. That agent reads
// the turn's events and the project's working tree, so a digest can say "it edited these four
// files and two of them no longer compile" -- a fact the transcript alone does not contain.
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

/**
 * One file the turn changed, as git reports it.
 *
 * From `git diff`, not from the transcript's tool calls: an Edit that was later reverted, or a
 * file written by a build the agent ran, are both invisible to a reading of the tool log and
 * both present here. `status` is git's name-status letter (`M`, `A`, `D`, `R`...).
 */
export interface SummaryFileChange {
  path: string;
  status: string;
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
 * One thing the summarizer did on its way to the digest.
 *
 * A digest is a claim about someone else's work, written by a model, and the only way to judge
 * it is to see what it looked at. `thinking` is the model's own reasoning text; `tool` is a file
 * it opened or a search it ran. Both are shown, in the order they happened.
 *
 * Bounded without a truncation flag, on purpose: the tool-call budget caps the `tool` entries,
 * one reasoning block precedes each of them at most, and each block's text is capped where it is
 * collected. There is no unbounded axis here, so there is nothing for a viewer to be told about.
 */
export type SummaryStep = SummaryThought | SummaryToolCall;

export interface SummaryThought {
  kind: "thinking";
  /** Capped at collection. Ends with an ellipsis when the model's block ran longer. */
  text: string;
}

export interface SummaryToolCall {
  kind: "tool";
  /** One of the read-only four: read, grep, find, ls. */
  name: string;
  /** What it was pointed at, as `pattern in path`. Empty when the call carried neither. */
  target: string;
  /** The tool reported an error. A summarizer that read a file that is not there is worth
   *  seeing, because it explains a digest that guessed. */
  failed: boolean;
}

/**
 * What the summary stream says while it works.
 *
 * The digest takes half a minute to write, and a spinner for that long is indistinguishable
 * from a hang. These are the same steps the finished `SummaryResult` carries, sent as they
 * happen, so the wait shows the work instead of hiding it.
 *
 * `thinking-delta` is the model's reasoning arriving in pieces, appended to the thought in
 * progress; the `step` that follows carries the same block assembled and REPLACES what the
 * deltas built, so a reader never has to reconcile two versions of one thought. Exactly one
 * `result` or one `error` ends the stream.
 */
export type SummaryStreamMessage =
  | { type: "step"; step: SummaryStep }
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
  /** How it got there, in order. Empty when the model answered from the prompt alone and its
   *  reasoning was not visible, which a non-reasoning model does. */
  steps: SummaryStep[];
  coverage: SummaryCoverage;
  /** The watched session's run state at the moment the digest was produced. */
  runState: AgentRunState;
}
