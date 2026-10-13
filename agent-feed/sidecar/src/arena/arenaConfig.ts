// Where the arena keeps its record of runs, where it makes their folders, and how it runs Claude.
//
// Read here rather than in `config.ts` for the reason `tools/runtime-paths.mjs` is a module of
// its own: a run's files are the arena's own state, and the module that owns that state reading
// its own environment keeps both the env names and the reasons for their shapes in one file.
// One reader, imported by the one place that builds the arena -- a value added to `config.ts`
// would read as a machine fact about every sidecar rather than a setting of this feature.

import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Where the arena keeps its record of runs: the run index and each closed contestant's diff. The
 * sidecar's own state, kept with the rest of it rather than among the folders a reader browses.
 */
export function arenaRoot(): string {
  const fromEnv = process.env.AGENT_FEED_ARENA_ROOT?.trim();
  return resolve(fromEnv || join(homedir(), "Library", "Application Support", "agentdesk-agent-feed", "arena"));
}

/**
 * The arena home: one folder per run, named after the run, holding its contestants' worktrees --
 * and, for a run that named no repository, the run's own new repository too. In the reader's home
 * and visible by path, because these are folders a reader opens, `cd`s into and trusts once.
 */
export function arenaHome(): string {
  const fromEnv = process.env.AGENT_FEED_ARENA_HOME?.trim();
  return resolve(fromEnv || join(homedir(), ".arena"));
}

/**
 * The model and effort a Claude contestant runs with, or null for the CLI's own defaults.
 * Deliberately not named per run yet: a duel's fairness lives in both contestants answering
 * the same question the same way, and the model is the first thing that changes when they do
 * not. The day a run wants to name models per contestant is the day this moves onto the
 * request.
 */
export function arenaClaudeModel(): string | null {
  return process.env.AGENT_FEED_ARENA_CLAUDE_MODEL?.trim() || null;
}

export function arenaClaudeEffort(): string | null {
  return process.env.AGENT_FEED_ARENA_CLAUDE_EFFORT?.trim() || null;
}
