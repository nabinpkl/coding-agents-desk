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

/** A model name as a harness's flag or the serve takes it: an id, an alias, `provider/model`. */
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/@\[\]-]{0,199}$/;

/** One lane as the service makes it. */
export interface CheckedLane {
  source: ArenaContestantSource;
  /** Null for the harness's own default. */
  model: string | null;
}

/**
 * The lanes a request names, or the problem with them: each a source this machine's drivers can
 * drive, and a model the harness could be handed. `already` is how many lanes the run has, so a
 * run that grows is held to the same cap as one asked for whole.
 */
export function checkLanes(
  raw: unknown,
  drivers: ContestantDrivers,
  already = 0,
): CheckedLane[] | { problem: string } {
  if (!Array.isArray(raw)) return { problem: "contestants must be a list of lanes" };
  if (already + raw.length > MAXIMUM_CONTESTANTS) {
    return { problem: `a run fans out to at most ${MAXIMUM_CONTESTANTS} contestants` };
  }
  const lanes: CheckedLane[] = [];
  for (const [index, lane] of raw.entries()) {
    const { source, model } = (lane ?? {}) as { source?: unknown; model?: unknown };
    // Named, not looked up: `drivers` is an object, and "toString" would find its prototype's.
    if ((source !== "opencode" && source !== "claude") || !Object.hasOwn(drivers, source)) {
      return { problem: `contestant ${index} names source "${String(source ?? "none")}", which this arena cannot drive` };
    }
    const named = typeof model === "string" ? model.trim() : model ?? null;
    if (named !== null && named !== "" && (typeof named !== "string" || !MODEL_NAME.test(named))) {
      return { problem: `contestant ${index} names model "${String(model)}", which is not a model name` };
    }
    if (source === "opencode" && named && !named.includes("/")) {
      return { problem: `contestant ${index} is opencode, whose model is named "provider/model", not "${named}"` };
    }
    lanes.push({ source: source as ArenaContestantSource, model: named || null });
  }
  return lanes;
}

export interface CheckedRunRequest {
  /** Trimmed; empty for a terminals run that opens its lanes before its prompt. */
  prompt: string;
  /** Trimmed; empty when the run is to get a repository of its own. */
  namedRepo: string;
  baseRef: string;
  mode: ArenaRunMode;
  drivers: ContestantDrivers;
  lanes: CheckedLane[];
  /** The manager's harness, or null for a run with none. */
  manager: ArenaContestantSource | null;
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

  const lanes = checkLanes(request.contestants, drivers);
  if ("problem" in lanes) return lanes;
  const manager = request.manager ?? null;
  if (manager !== null && manager !== "opencode" && manager !== "claude") {
    return { problem: `the manager names source "${String(manager)}", which this arena cannot run` };
  }
  // A manager is a session in a pane, which a headless run has none of.
  if (manager !== null && mode !== "terminals") return { problem: "only a terminals run can have a manager" };
  // No lanes is a run whose manager will add them, which it can only do before the first prompt.
  if (lanes.length === 0 && (manager === null || prompt)) {
    return { problem: "a run needs at least one contestant, unless it has a manager to add them and no prompt yet" };
  }
  return { prompt, namedRepo, baseRef, mode, drivers, lanes, manager };
}
