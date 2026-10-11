// Where the arena keeps its runs, and the repository one falls back to.
//
// Read here rather than in `config.ts` for the reason `tools/runtime-paths.mjs` is a module of
// its own: a run's files are the arena's own state, and the module that owns that state reading
// its own environment keeps both the env names and the reasons for their shapes in one file.
// One reader, imported by the one place that builds the arena -- a value added to `config.ts`
// would read as a machine fact about every sidecar rather than a setting of this feature.

import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Where the arena puts its runs: one directory per run holding the contestants' worktrees and
 * facts. Outside any repository by default, because a run's target repo is per-run state chosen
 * by whoever asked for the run, not a constant of this sidecar; a machine that wants its arena
 * beside a repo points this at a gitignored path.
 */
export function arenaRoot(): string {
  const fromEnv = process.env.AGENT_FEED_ARENA_ROOT?.trim();
  return resolve(fromEnv || join(homedir(), "Library", "Application Support", "agentdesk-agent-feed", "arena"));
}

/**
 * The repository a run fans out into when the caller does not name one, or null to require
 * one. Deliberately no default: the panel's own repo is a machine fact this sidecar cannot
 * know, and guessing one would silently duel a checkout nobody chose.
 */
export function arenaDefaultRepoPath(): string | null {
  return process.env.AGENT_FEED_ARENA_DEFAULT_REPO?.trim() || null;
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
