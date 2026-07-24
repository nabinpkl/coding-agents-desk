import { homedir } from "node:os";
import { join, resolve } from "node:path";

function integerEnvironment(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be a number`);
  }
  if (value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function directoryEnvironment(name: string, fallback: string): string {
  const raw = process.env[name];
  return resolve(raw === undefined || raw === "" ? fallback : raw);
}

const userHomeDirectory = homedir();
const staleThresholdMs = integerEnvironment(
  "AGENT_FEED_STALE_THRESHOLD_MS",
  2 * 60 * 60 * 1000,
  60 * 1000,
  7 * 24 * 60 * 60 * 1000,
);
const readyThresholdMs = integerEnvironment(
  "AGENT_FEED_READY_THRESHOLD_MS",
  5 * 60 * 1000,
  1000,
  60 * 60 * 1000,
);

if (readyThresholdMs >= staleThresholdMs) {
  throw new Error("AGENT_FEED_READY_THRESHOLD_MS must be less than AGENT_FEED_STALE_THRESHOLD_MS");
}

export const config = {
  host: process.env.AGENT_FEED_HOST ?? "127.0.0.1",
  port: integerEnvironment("AGENT_FEED_PORT", 7682, 1, 65_535),
  stateDirectory: directoryEnvironment(
    "AGENT_FEED_STATE_DIR",
    join(
      userHomeDirectory,
      "Library",
      "Application Support",
      "com.example.agentdesk.AgentDeskHost",
      "AgentFeed",
    ),
  ),
  claudeProjectsDirectory: directoryEnvironment(
    "AGENT_FEED_CLAUDE_PROJECTS_DIR",
    join(userHomeDirectory, ".claude", "projects"),
  ),
  codexHomeDirectory: directoryEnvironment(
    "AGENT_FEED_CODEX_HOME",
    join(userHomeDirectory, ".codex"),
  ),
  staleThresholdMs,
  readyThresholdMs,
  liveWindowMs: integerEnvironment(
    "AGENT_FEED_LIVE_WINDOW_MS",
    2 * 60 * 1000,
    1000,
    30 * 60 * 1000,
  ),
} as const;
