// The record that makes a park reversible.
//
// Written BEFORE the first window moves, because the park outlives the process
// that made it. Between the first move and the last restore the sidecar can be
// killed, updated, or simply quit by someone who has forgotten what it did to
// their Desktops; without this file that leaves a heap of windows on one
// Desktop and no way to know where any of them came from.
//
// Design note and rationale: docs/superpowers/specs/2026-08-25-desktop-park-manifest-design.md
//
// Two things that document calls out and this file implements:
//
//   - A window id is an ADDRESS, not an identity. They are reused: Codex Desktop
//     restarted mid-measurement and its windows went 540230/573876 ->
//     583212/584335 with the pid moving too. An entry is applied only when the
//     live window at that id still corroborates the record.
//   - A Space index is not durable either. It shifts when Desktops are added,
//     removed, or reordered, so home is recorded as yabai's space `uuid` and
//     resolved back to an index at restore time.

import { open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";
import { config } from "@/config/config";
import type { Rect } from "@/park/ladder";

export const PARK_MANIFEST_VERSION = 1;

export type ParkState = "gathering" | "parked" | "restoring";

export interface ParkEntry {
  windowID: number;
  /** Corroborating identity. All three must still match before an entry is applied. */
  ownerPID: number;
  app: string;
  size: { w: number; h: number };
  /** Informational only; `title` changes on its own and is never matched on. */
  title: string;
  /** Durable home. The index is a convenience; the uuid is the truth. */
  homeSpaceUUID: string;
  homeSpaceIndex: number;
  homeFrame: Rect;
  /** Filled once the ladder is laid. Null while the park is still gathering. */
  parkFrame: Rect | null;
  side: "left" | "right" | null;
  rung: number | null;
  restored: boolean;
}

export interface ParkManifest {
  version: number;
  parkedAt: number;
  /** Where the pile went. Recorded by uuid for the same reason home is. */
  parkSpaceUUID: string;
  parkSpaceIndex: number;
  state: ParkState;
  entries: ParkEntry[];
}

export function manifestPath(): string {
  return config.parkManifestPath;
}

/**
 * Atomic write: temp file in the same directory, flushed, then renamed.
 *
 * A half-written manifest is worse than none, because it would be parsed,
 * believed, and used to move windows to coordinates that were never recorded.
 */
export async function writeManifest(manifest: ParkManifest): Promise<void> {
  const path = manifestPath();
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const temp = join(dir, `.park-manifest.${process.pid}.tmp`);
  const handle = await open(temp, "w", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temp, path);
}

/**
 * The manifest on disk, or null when there is none.
 *
 * An unreadable or unknown-version manifest returns null rather than throwing:
 * the windows are then left exactly where they are, which a human can undo by
 * hand. Guessing at an unknown shape and moving windows on that guess cannot be
 * undone by hand.
 */
export async function readManifest(): Promise<ParkManifest | null> {
  const file = Bun.file(manifestPath());
  if (!(await file.exists())) return null;
  let parsed: unknown;
  try {
    parsed = await file.json();
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const m = parsed as Partial<ParkManifest>;
  if (m.version !== PARK_MANIFEST_VERSION) return null;
  if (!Array.isArray(m.entries) || typeof m.parkSpaceUUID !== "string") return null;
  return m as ParkManifest;
}

export async function clearManifest(): Promise<void> {
  await rm(manifestPath(), { force: true });
}

/** A live window, as far as corroboration cares. */
export interface Corroborable {
  id: number;
  pid: number;
  app: string;
  frame: Rect;
}

/**
 * Whether the window living at this entry's id is still the window the entry
 * describes.
 *
 * Title is deliberately excluded: a codex window is titled by its thread and
 * changes on its own, so matching on it would orphan entries that are perfectly
 * valid.
 */
export function corroborates(entry: ParkEntry, live: Corroborable | undefined): boolean {
  if (!live) return false;
  return (
    live.pid === entry.ownerPID
    && live.app === entry.app
    && live.frame.w === entry.size.w
    && live.frame.h === entry.size.h
  );
}
