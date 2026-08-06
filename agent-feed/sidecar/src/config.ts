import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

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

function booleanEnvironment(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  if (raw === "1" || raw.toLowerCase() === "true") return true;
  if (raw === "0" || raw.toLowerCase() === "false") return false;
  throw new Error(`${name} must be "true" or "false"`);
}

function urlEnvironment(name: string, fallback: string): URL {
  const raw = process.env[name];
  const value = raw === undefined || raw.trim() === "" ? fallback : raw.trim();
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw new Error(`${name} must be a valid http(s) URL: ${value}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${name} must be an http(s) URL`);
  }
  return parsed;
}

function directoryEnvironment(name: string, fallback: string): string {
  const raw = process.env[name];
  return resolve(raw === undefined || raw === "" ? fallback : raw);
}

// Context window per model, in tokens, for the Agent Panel's occupancy meter.
//
// Keyed by model-id PREFIX and matched longest-first, because the harness writes
// full ids (`claude-opus-4-8`) and CLI aliases (`sonnet`) interchangeably, and a
// point release must not silently drop the meter to a bare count. Only Claude
// reads this table: Codex publishes `model_context_window` in the transcript
// itself, which is authoritative and observed to change mid-project.
const DEFAULT_CONTEXT_WINDOWS: Readonly<Record<string, number>> = {
  "claude-opus": 200_000,
  "claude-sonnet": 200_000,
  "claude-haiku": 200_000,
  opus: 200_000,
  sonnet: 200_000,
  haiku: 200_000,
};

// `AGENT_FEED_CONTEXT_WINDOWS="claude-opus-5=1000000,claude-sonnet=200000"`
// describes a model this build has never seen, or a long-context beta run,
// without a code change. Entries merge over the defaults rather than replacing
// them, so naming one model does not blank every other model's meter.
function contextWindowEnvironment(name: string): Record<string, number> {
  const table: Record<string, number> = { ...DEFAULT_CONTEXT_WINDOWS };
  const raw = process.env[name];
  if (raw === undefined || raw === "") return table;
  for (const entry of raw.split(",")) {
    if (!entry.trim()) continue;
    const separator = entry.lastIndexOf("=");
    const prefix = separator > 0 ? entry.slice(0, separator).trim() : "";
    if (!prefix) {
      throw new Error(`${name} entries must be "modelPrefix=tokens"`);
    }
    const tokens = Number(entry.slice(separator + 1).trim());
    if (!Number.isSafeInteger(tokens) || tokens <= 0) {
      throw new Error(`${name} window for "${prefix}" must be a positive integer`);
    }
    table[prefix] = tokens;
  }
  return table;
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

// The HTTP client capability is process-local authority. Snapshot it for the
// server, then remove it before Pi constructs tools whose child processes inherit
// process.env. A model-authored bash command must never be able to call the
// authenticated control API or answer its own extension prompt.
const controlToken = process.env.AGENT_FEED_CONTROL_TOKEN?.trim() || null;
delete process.env.AGENT_FEED_CONTROL_TOKEN;

export const config = {
  host: process.env.AGENT_FEED_HOST ?? "127.0.0.1",
  port: integerEnvironment("AGENT_FEED_PORT", 7682, 1, 65_535),
  claudeProjectsDirectory: directoryEnvironment(
    "AGENT_FEED_CLAUDE_PROJECTS_DIR",
    join(userHomeDirectory, ".claude", "projects"),
  ),
  codexHomeDirectory: directoryEnvironment(
    "AGENT_FEED_CODEX_HOME",
    join(userHomeDirectory, ".codex"),
  ),
  piAgentDirectory: directoryEnvironment(
    "AGENT_FEED_PI_AGENT_DIR",
    getAgentDir(),
  ),
  piSessionsDirectory: directoryEnvironment(
    "AGENT_FEED_PI_SESSIONS_DIR",
    process.env.PI_CODING_AGENT_SESSION_DIR || join(getAgentDir(), "sessions"),
  ),
  controlToken,
  piIdleRuntimeMs: integerEnvironment(
    "AGENT_FEED_PI_IDLE_RUNTIME_MS",
    10 * 60 * 1000,
    1000,
    24 * 60 * 60 * 1000,
  ),
  piToolCallBudget: integerEnvironment(
    "AGENT_FEED_PI_TOOL_CALL_BUDGET",
    64,
    1,
    1024,
  ),
  discoveryRescanMs: integerEnvironment(
    "AGENT_FEED_DISCOVERY_RESCAN_MS",
    60_000,
    1_000,
    10 * 60_000,
  ),
  staleThresholdMs,
  readyThresholdMs,
  liveWindowMs: integerEnvironment(
    "AGENT_FEED_LIVE_WINDOW_MS",
    2 * 60 * 1000,
    1000,
    30 * 60 * 1000,
  ),
  contextWindows: contextWindowEnvironment("AGENT_FEED_CONTEXT_WINDOWS"),
  proxyObserverEndpoint: urlEnvironment(
    "AGENT_FEED_PROXY_OBSERVER_ENDPOINT",
    "http://127.0.0.1:9155",
  ),
  claudeLiveEnabled: booleanEnvironment("AGENT_FEED_CLAUDE_LIVE_ENABLED", true),
  claudeLiveReconnectMs: integerEnvironment(
    "AGENT_FEED_CLAUDE_LIVE_RECONNECT_MS",
    1000,
    50,
    60_000,
  ),
  claudeLiveReconnectMaxMs: integerEnvironment(
    "AGENT_FEED_CLAUDE_LIVE_RECONNECT_MAX_MS",
    30_000,
    1_000,
    5 * 60_000,
  ),
  claudeLiveMaxSessions: integerEnvironment(
    "AGENT_FEED_CLAUDE_LIVE_MAX_SESSIONS",
    64,
    1,
    512,
  ),
  claudeLiveIdleDropMs: integerEnvironment(
    "AGENT_FEED_CLAUDE_LIVE_IDLE_DROP_MS",
    30_000,
    1_000,
    10 * 60_000,
  ),
} as const;

/**
 * The model's context window in tokens, or null when this build has no entry.
 *
 * Null is a real answer, not a failure: the panel then shows the occupancy count
 * with no fill bar, rather than a fraction of a number we guessed.
 */
export function contextWindowFor(model: string | undefined): number | null {
  if (!model) return null;
  const id = model.toLowerCase();
  let best: { length: number; tokens: number } | null = null;
  for (const [prefix, tokens] of Object.entries(config.contextWindows)) {
    const candidate = prefix.toLowerCase();
    if (!id.startsWith(candidate)) continue;
    if (!best || candidate.length > best.length) {
      best = { length: candidate.length, tokens };
    }
  }
  return best?.tokens ?? null;
}
