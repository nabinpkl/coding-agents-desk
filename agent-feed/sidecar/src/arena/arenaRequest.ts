// What a request for a run, or for a run's next prompt, must say before anything is made for it.
//
// Pure: it reads the request and the modes and drivers this machine has, and answers either the
// request in the shape the service builds from, or the one problem a reader is told. The checks
// that touch the disk -- whether a named repository is one, whether the run's name is free --
// stay with the service, which owns the disk.

import type {
  ArenaContestantSource,
  ArenaCreateRunRequest,
  ArenaRunMode,
} from "@agentdesk/agent-feed-wire";
import type { ContestantDrivers } from "@/arena/contestants/contestantDriver";

/** The most contestants one run may fan out to; past this a run stops being watchable. */
export const MAXIMUM_CONTESTANTS = 8;

/** A prompt past this is refused rather than typed into a dozen panes. */
const MAXIMUM_PROMPT_CHARACTERS = 16_000;

/** The problem with a prompt as a run would send it, or null when it may be sent. */
export function promptProblem(prompt: string): string | null {
  return prompt.length > MAXIMUM_PROMPT_CHARACTERS
    ? `a run's prompt is capped at ${MAXIMUM_PROMPT_CHARACTERS} characters`
    : null;
}

export interface CheckedRunRequest {
  /** Trimmed; empty for a terminals run that opens its lanes before its prompt. */
  prompt: string;
  /** Trimmed; empty when the run is to get a repository of its own. */
  namedRepo: string;
  baseRef: string;
  mode: ArenaRunMode;
  drivers: ContestantDrivers;
  sources: ArenaContestantSource[];
  /** The judge's harness, or null for a run with none. */
  judge: ArenaContestantSource | null;
}

/**
 * The request as the service builds a run from it, or the problem with it. `modes` is what this
 * machine can run, first the default; `driversFor` answers null for a mode it has no drivers for.
 */
export function checkRunRequest(
  request: ArenaCreateRunRequest,
  machine: { modes: readonly ArenaRunMode[]; driversFor: (mode: ArenaRunMode) => ContestantDrivers | null },
): CheckedRunRequest | { problem: string } {
  const prompt = typeof request.prompt === "string" ? request.prompt.trim() : "";
  const tooLong = promptProblem(prompt);
  if (tooLong) return { problem: tooLong };
  const namedRepo = typeof request.repoPath === "string" ? request.repoPath.trim() : "";
  const baseRef = typeof request.baseRef === "string" && request.baseRef.trim() ? request.baseRef.trim() : "HEAD";

  const mode: ArenaRunMode = request.mode ?? machine.modes[0]!;
  if (mode !== "terminals" && mode !== "headless") {
    return { problem: `mode must be "terminals" or "headless", not "${String(mode)}"` };
  }
  const drivers = machine.driversFor(mode);
  if (!drivers) return { problem: "this machine has no tmux, so a run here can only be headless" };
  // A terminals run may open its lanes first and take its prompt once they are up; a headless
  // run has nothing to open, so its prompt is the run.
  if (!prompt && mode === "headless") return { problem: "a run needs a prompt" };

  if (!Array.isArray(request.contestants) || request.contestants.length === 0) {
    return { problem: "a run needs at least one contestant" };
  }
  if (request.contestants.length > MAXIMUM_CONTESTANTS) {
    return { problem: `a run fans out to at most ${MAXIMUM_CONTESTANTS} contestants` };
  }
  const sources: ArenaContestantSource[] = [];
  for (const [index, contestant] of request.contestants.entries()) {
    if (!contestant || !drivers[contestant.source as ArenaContestantSource]) {
      return {
        problem: `contestant ${index} names source "${contestant?.source ?? "none"}", which this arena cannot drive`,
      };
    }
    sources.push(contestant.source);
  }
  const judge = request.judge ?? null;
  if (judge !== null && judge !== "opencode" && judge !== "claude") {
    return { problem: `the judge names source "${String(judge)}", which this arena cannot run` };
  }
  // A judge is a session in a pane, which a headless run has none of.
  if (judge !== null && mode !== "terminals") return { problem: "only a terminals run can have a judge" };
  return { prompt, namedRepo, baseRef, mode, drivers, sources, judge };
}
