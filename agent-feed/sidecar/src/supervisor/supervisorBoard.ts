// The files the panel's dev server and this Mac's sidecar supervisor read each other through.
//
// A sidecar change and the panel change that goes with it -- a route renamed and its caller, a
// field added and the card that reads it -- used to land whenever each half was saved. The sidecar
// restarted on its own save, the panel took its own update on another, and in between the panel was
// running against a sidecar it did not match, which on the canvas reads as every card failing at
// once. So the two now decide together: the supervisor restarts only once BOTH trees have gone
// quiet, and the dev server holds the panel's updates while a sidecar change is waiting and reloads
// it onto the new sidecar once that one is up. Each side needs one fact about the other, and these
// are the files that carry them.
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

/** What the supervisor is doing, as far as the panel's dev server needs to know. */
export interface SupervisorPending {
  /** True while a sidecar change is waiting to be taken. */
  readonly held: boolean;
  /** Only `auto` restarts on its own; under `manual` the reader is the one who decides. */
  readonly mode: "auto" | "manual";
}

/** `<registry>/<user>.panel.json`, beside the supervisor's own. */
export function panelActivityPath(dir: string): string {
  return join(dir, `${userInfo().username}.panel.json`);
}

/** `<registry>/<user>.supervisor.json`, which `sidecarRegistry.ts` writes. */
export function supervisorDescriptorPath(dir: string): string {
  return join(dir, `${userInfo().username}.supervisor.json`);
}

/** `<registry>/<user>.json`, the sidecar's own announcement. */
function sidecarDescriptorPath(dir: string): string {
  return join(dir, `${userInfo().username}.json`);
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

/** The supervisor's own state, or null when nothing live is supervising this machine's sidecar. */
export function readSupervisorPending(dir: string, now = Date.now()): SupervisorPending | null {
  const raw = readJson(supervisorDescriptorPath(dir));
  if (!raw || !fresh(raw, now)) return null;
  return { held: raw.held === true, mode: raw.mode === "manual" ? "manual" : "auto" };
}

/**
 * When the sidecar now on the board started, or null when none is.
 *
 * A start later than the moment the panel began holding means the restart it was waiting for has
 * happened and the new sidecar is listening: it announces only once it serves.
 */
export function readSidecarStartedAt(dir: string, now = Date.now()): number | null {
  const raw = readJson(sidecarDescriptorPath(dir));
  if (!raw || !fresh(raw, now)) return null;
  return typeof raw.startedAt === "number" ? raw.startedAt : null;
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
