// What the panel's dev server tells this Mac's sidecar supervisor about the panel's tree.
//
// An agent's change is often a sidecar half and a panel half -- a route renamed and its caller -- and
// a restart on the sidecar's half alone puts the panel against a sidecar it does not match. So the
// supervisor restarts only once the panel's tree has gone quiet too, and not beside a panel file
// that will not parse; this file is how it hears about that. The panel does not wait in return: it
// once held its own updates while a sidecar change was pending and reloaded every page afterwards,
// which with several agents at work reloaded the canvas far more often than it saved it.
//
// No `@/` or `@repo/` imports, for the reason `sourceVersion.ts` has none: the dev server loads this
// from `vite.config.ts` under Node, where this tree's aliases do not exist. So every function takes
// the registry directory, and the caller resolves it (`runtimePaths().sidecarRegistry`).
//
// The board is the one the sidecar already announces itself on, so both processes can write it.
// What it cannot do is cross machines: a peer's supervisor sees no panel here and couples to
// nothing, which leaves it the quiet window and nothing else.

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";

/** Heartbeats on this board are every 5s, and a reader ages an entry out at three misses. */
export const BOARD_STALE_MS = 15_000;

/** What the dev server says about the panel's tree, for the supervisor to wait on. */
export interface PanelActivity {
  /** When a panel or wire source file last changed, by the dev server's clock. */
  readonly changedAt: number;
  /** Which panel file will not parse and why, or null. A restart now would meet a broken panel. */
  readonly blocked: string | null;
}

/** `<registry>/<user>.panel.json`, beside the supervisor's own. */
export function panelActivityPath(dir: string): string {
  return join(dir, `${userInfo().username}.panel.json`);
}

/** `<registry>/<user>.supervisor.json`, which `sidecarRegistry.ts` writes and reads. */
export function supervisorDescriptorPath(dir: string): string {
  return join(dir, `${userInfo().username}.supervisor.json`);
}

/** Write what the panel is doing, temp-then-rename so the supervisor never reads half of it. */
export function writePanelActivity(dir: string, activity: PanelActivity, now = Date.now()): void {
  const file = panelActivityPath(dir);
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify({ ...activity, heartbeat: now }));
  renameSync(temporary, file);
}

/**
 * What the panel is doing, or null when no live dev server is saying.
 *
 * Null is not "the panel is quiet", it is "there is no panel here to wait for": a peer, a bundled
 * panel, a dev server that stopped. The supervisor then decides on its own tree alone.
 */
export function readPanelActivity(dir: string, now = Date.now()): PanelActivity | null {
  const raw = readJson(panelActivityPath(dir));
  if (!raw || !fresh(raw, now)) return null;
  return {
    changedAt: typeof raw.changedAt === "number" ? raw.changedAt : 0,
    blocked: typeof raw.blocked === "string" ? raw.blocked : null,
  };
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function fresh(raw: Record<string, unknown>, now: number): boolean {
  return typeof raw.heartbeat === "number" && now - raw.heartbeat <= BOARD_STALE_MS;
}
