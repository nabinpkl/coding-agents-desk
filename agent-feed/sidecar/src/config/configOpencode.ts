// This machine's opencode serve: where it answers and what opens it.
//
// Split out of `config.ts` when the opencode source landed, for the reason
// every sibling here exists: one idea per file, and the password reader is an
// idea of its own. Imported by `config.ts`, never by callers directly.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { integerEnvironment, urlEnvironment } from "@/config/configEnvironment";

/**
 * The opencode serve's Basic-auth password, without which its API answers 401.
 *
 * Env wins so a peer can inject its own without touching files. Otherwise the
 * serve's own `service.json` is read -- it is this machine's service
 * credential, not a reader's OAuth token, so holding it in the sidecar follows
 * the same rule as the Pi backends holding their runtimes: it never enters
 * the panel.
 */
export function readOpencodePassword(): string | null {
  const fromEnv = process.env.AGENT_FEED_OPENCODE_PASSWORD?.trim();
  if (fromEnv) return fromEnv;
  try {
    const serviceFile = join(homedir(), ".config", "opencode", "service.json");
    if (!existsSync(serviceFile)) return null;
    const password = (JSON.parse(readFileSync(serviceFile, "utf8")) as { password?: unknown }).password;
    return typeof password === "string" && password.length > 0 ? password : null;
  } catch {
    return null;
  }
}

export function opencodeServeUrl(): URL {
  // Each sidecar talks to its own machine's serve: the panel already fans out
  // per machine, so no frontend branching is needed for oracle peers.
  return urlEnvironment("AGENT_FEED_OPENCODE_URL", "http://127.0.0.1:49374");
}

export function opencodeReconcileMs(): number {
  return integerEnvironment("AGENT_FEED_OPENCODE_RECONCILE_MS", 30_000, 5_000, 10 * 60_000);
}

export function opencodeIdleMs(): number {
  return integerEnvironment("AGENT_FEED_OPENCODE_IDLE_MS", 10 * 60 * 1000, 1000, 24 * 60 * 60 * 1000);
}

/**
 * Where opencode keeps its provider credentials. Read-only to us: the file belongs to opencode.
 * `AGENT_FEED_OPENCODE_AUTH_PATH` overrides it for tests and peers with a different data dir.
 */
export function opencodeAuthPath(): string {
  const override = process.env.AGENT_FEED_OPENCODE_AUTH_PATH?.trim();
  if (override) return override;
  const dataHome = process.env.XDG_DATA_HOME?.trim() || join(homedir(), ".local", "share");
  return join(dataHome, "opencode", "auth.json");
}

/**
 * The OpenCode Go plan key, or null when the file or the `opencode-go` entry is absent or
 * malformed (then the sidecar shows no Go meters at all). Held in the sidecar only: it is never
 * logged, never put on the wire, and the file is never written. Read on every poll rather than
 * cached, so a rotated key is picked up and a removed one stops the meters.
 */
export function readOpencodeGoKey(path: string = opencodeAuthPath()): string | null {
  try {
    const entry = (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown> | null)?.["opencode-go"];
    const key = (entry as { key?: unknown } | null | undefined)?.key;
    return typeof key === "string" && key.trim().length > 0 ? key.trim() : null;
  } catch {
    return null;
  }
}

/** An undocumented endpoint (same body at `/inference/go/v1/usage`); override if it moves. */
export function opencodeGoUsageUrl(): URL {
  return urlEnvironment("AGENT_FEED_OPENCODE_GO_USAGE_URL", "https://opencode.ai/zen/go/v1/usage");
}

/** Never faster than a minute: the plan meter moves with spend, not by the second. */
export function opencodeGoPollMs(): number {
  return integerEnvironment("AGENT_FEED_OPENCODE_GO_POLL_MS", 120_000, 60_000, 60 * 60_000);
}
