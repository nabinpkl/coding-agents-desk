// Where scratch chats get their folders, and where the brief tells an agent projects belong.
//
// Read here rather than in `config.ts` for the reason `arenaConfig.ts` gives for the arena's: the
// folders are this feature's own state, and the module that makes them reading its own environment
// keeps the names and the reasons for their shapes in one file.

import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * The folder every scratch chat's own folder is made in.
 *
 * Kept with the sidecar's other durable state rather than in a temporary directory: a chat that
 * turns out to matter must still have its files after a restart, and the system clears `/tmp` and
 * may clear `~/Library/Caches` on its own.
 */
export function scratchRoot(): string {
  const fromEnv = process.env.AGENT_FEED_SCRATCH_ROOT?.trim();
  return resolve(fromEnv || join(homedir(), "Library", "Application Support", "agentdesk-agent-feed", "scratch"));
}

/** Where the brief tells a scratch chat's agent a lasting project should live. */
export function projectsHome(): string {
  const fromEnv = process.env.AGENT_FEED_PROJECTS_HOME?.trim();
  return resolve(fromEnv || join(homedir(), "projects"));
}
