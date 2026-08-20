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
  coverage: SummaryCoverage;
  /** The watched session's run state at the moment the digest was produced. */
  runState: AgentRunState;
}
