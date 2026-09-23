// Parking, in two phases, because one pass ranks against an order that does not
// survive the first phase.
//
// The ladder needs windows ordered front-to-back, and offsets must run
// monotonically with that order or a window sandwiched between two neighbours is
// covered by their union and stops rendering. But before a park, the candidates
// are spread across many Desktops, and z-order across Desktops is not a real
// ordering: once they are co-located the stack is whatever macOS produced while
// they arrived. So:
//
//   1. GATHER   move every candidate to the target Space. No frames touched.
//   2. SETTLE   let the window server finish reordering.
//   3. RE-READ  ask yabai for the order the windows actually ended up in.
//   4. LAY      compute the ladder against THAT order and apply the frames.
//
// The target Space is captured once, by uuid, and does not follow the user. They
// switch Desktops constantly, and a park that chases the active Space would
// scatter its own pile. It parks where it started and stays there.

import { config } from "@/config/config";
import { type LadderPlan, plan as planLadder, type Rect } from "@/park/ladder";
import {
  clearManifest,
  corroborates,
  type ParkEntry,
  type ParkManifest,
  PARK_MANIFEST_VERSION,
  readManifest,
  writeManifest,
} from "@/park/manifest";
import {
  activeSpace,
  displays,
  moveTo,
  moveToSpace,
  parkable,
  spaces,
  windows,
  type YabaiWindow,
} from "@/park/yabai";

export interface ParkOptions {
  /** Substring match on the application name. Absent means every parkable window. */
  app?: string;
  /** Report what would happen and touch nothing. */
  dryRun?: boolean;
}

export interface ParkStepResult {
  id: number;
  app: string;
  ok: boolean;
  detail?: string;
}

export interface ParkReport {
  targetSpace: { index: number; uuid: string };
  candidates: number;
  gathered: ParkStepResult[];
  /** The order the windows actually settled into, which is what the ladder used. */
  observedOrder: number[];
  /** Order they had before the gather, kept so the difference is visible. */
  orderBeforeGather: number[];
  laid: ParkStepResult[];
  plan: LadderPlan | null;
  sound: boolean;
  manifestPath: string | null;
  dryRun: boolean;
}

function rectOf(w: YabaiWindow): Rect {
  return { x: w.frame.x, y: w.frame.y, w: w.frame.w, h: w.frame.h };
}

const settle = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function park(options: ParkOptions = {}): Promise<ParkReport> {
  const [all, space, screens, spaceList] = await Promise.all([
    windows(),
    activeSpace(),
    displays(),
    spaces(),
  ]);
  const target = spaceList.find((s) => s.index === space.index);
  if (!target) throw new Error(`yabai does not report the active space ${space.index}`);
  const screen = screens.find((d) => d.index === space.display) ?? screens[0];
  if (!screen) throw new Error("yabai reports no displays");

  const filter = options.app?.toLowerCase();
  const candidates = parkable(all).filter((w) => !filter || w.app.toLowerCase().includes(filter));
  const spaceByIndex = new Map(spaceList.map((s) => [s.index, s]));
  const orderBeforeGather = candidates.map((w) => w.id);

  const report: ParkReport = {
    targetSpace: { index: target.index, uuid: target.uuid },
    candidates: candidates.length,
    gathered: [],
    observedOrder: [],
    orderBeforeGather,
    laid: [],
    plan: null,
    sound: false,
    manifestPath: null,
    dryRun: options.dryRun === true,
  };
  if (candidates.length === 0) return report;

  // The manifest lands before anything moves. If this write fails, the park does
  // not start, because an unrecorded park is a one-way trip.
  const entries: ParkEntry[] = candidates.map((w) => {
    const home = spaceByIndex.get(w.space);
    return {
      windowID: w.id,
      ownerPID: w.pid,
      app: w.app,
      size: { w: w.frame.w, h: w.frame.h },
      title: w.title,
      homeSpaceUUID: home?.uuid ?? target.uuid,
      homeSpaceIndex: w.space,
      homeFrame: rectOf(w),
      parkFrame: null,
      side: null,
      rung: null,
      restored: false,
    };
  });
  const manifest: ParkManifest = {
    version: PARK_MANIFEST_VERSION,
    parkedAt: Date.now(),
    parkSpaceUUID: target.uuid,
    parkSpaceIndex: target.index,
    state: "gathering",
    entries,
  };

  if (options.dryRun) {
    const laid = planLadder(
      candidates.map((w) => ({ id: w.id, frame: rectOf(w) })),
      { display: screen.frame, strip: config.parkStrip, step: config.parkStep, topMargin: config.parkTopMargin },
    );
    report.plan = laid;
    report.sound = laid.starved.length === 0;
    report.observedOrder = orderBeforeGather;
    return report;
  }

  await writeManifest(manifest);
  report.manifestPath = config.parkManifestPath;

  // Phase 1: gather. Space only, frames untouched, so nothing is laid out
  // against an order that is about to change.
  for (const w of candidates) {
    if (w.space === target.index) {
      report.gathered.push({ id: w.id, app: w.app, ok: true, detail: "already here" });
      continue;
    }
    const outcome = await moveToSpace(w.id, target.index);
    report.gathered.push({ id: w.id, app: w.app, ok: outcome.ok, detail: outcome.reason });
  }

  // Phase 2: settle, then ask what the order actually became.
  await settle(config.parkSettleMs);
  const after = await windows();
  const wanted = new Set(candidates.map((w) => w.id));
  const settled = after.filter((w) => wanted.has(w.id) && w.space === target.index);
  report.observedOrder = settled.map((w) => w.id);

  // Phase 3: lay the ladder against the observed order.
  const laid = planLadder(
    settled.map((w) => ({ id: w.id, frame: rectOf(w) })),
    { display: screen.frame, strip: config.parkStrip, step: config.parkStep, topMargin: config.parkTopMargin },
  );
  report.plan = laid;
  report.sound = laid.starved.length === 0;

  for (const p of laid.placements) {
    const outcome = await moveTo(p.id, p.x, p.y);
    const w = settled.find((s) => s.id === p.id);
    report.laid.push({ id: p.id, app: w?.app ?? "?", ok: outcome.ok, detail: outcome.reason });
    const entry = manifest.entries.find((e) => e.windowID === p.id);
    if (entry && outcome.observed) {
      entry.parkFrame = outcome.observed.frame;
      entry.side = p.side;
      entry.rung = p.rung;
    }
  }

  manifest.state = "parked";
  await writeManifest(manifest);
  return report;
}

export interface RestoreResult {
  windowID: number;
  app: string;
  outcome: "restored" | "orphaned" | "moved-by-user" | "failed";
  detail?: string;
}

export interface RestoreReport {
  found: boolean;
  parkedAt: number | null;
  results: RestoreResult[];
  manifestCleared: boolean;
}

/**
 * Put everything back, entry by entry, verifying each landing.
 *
 * Two things it refuses to do. It will not apply an entry whose live window no
 * longer corroborates the record, because a reused window id would send a
 * stranger's window to coordinates it never had. And it will not move a window
 * the user has already dragged off the park Space themselves; their placement
 * wins over a stale record of ours.
 */
export async function restore(): Promise<RestoreReport> {
  const manifest = await readManifest();
  if (!manifest) return { found: false, parkedAt: null, results: [], manifestCleared: false };

  manifest.state = "restoring";
  await writeManifest(manifest);

  const [all, spaceList] = await Promise.all([windows(), spaces()]);
  const live = new Map(all.map((w) => [w.id, w]));
  const indexByUUID = new Map(spaceList.map((s) => [s.uuid, s.index]));
  const results: RestoreResult[] = [];

  for (const entry of manifest.entries) {
    if (entry.restored) continue;
    const current = live.get(entry.windowID);
    if (!corroborates(entry, current)) {
      results.push({
        windowID: entry.windowID,
        app: entry.app,
        outcome: "orphaned",
        detail: current
          ? `live window is pid ${current.pid} ${current.app} ${current.frame.w}x${current.frame.h}`
          : "no window with this id",
      });
      continue;
    }
    if (current!.space !== manifest.parkSpaceIndex) {
      results.push({
        windowID: entry.windowID,
        app: entry.app,
        outcome: "moved-by-user",
        detail: `now on space ${current!.space}`,
      });
      continue;
    }
    const homeIndex = indexByUUID.get(entry.homeSpaceUUID);
    if (homeIndex === undefined) {
      results.push({
        windowID: entry.windowID,
        app: entry.app,
        outcome: "failed",
        detail: `home space ${entry.homeSpaceUUID} no longer exists`,
      });
      continue;
    }
    const toFrame = await moveTo(entry.windowID, entry.homeFrame.x, entry.homeFrame.y);
    const toSpace = await moveToSpace(entry.windowID, homeIndex);
    const ok = toSpace.ok;
    if (ok) {
      entry.restored = true;
      results.push({
        windowID: entry.windowID,
        app: entry.app,
        outcome: "restored",
        detail: toFrame.ok ? undefined : toFrame.reason,
      });
    } else {
      results.push({
        windowID: entry.windowID,
        app: entry.app,
        outcome: "failed",
        detail: toSpace.reason,
      });
    }
    await writeManifest(manifest);
  }

  // Cleared only when nothing is left waiting. An orphan is not waiting: no
  // future run can help it, and keeping the file would re-run this forever.
  const settledAll = manifest.entries.every(
    (e) => e.restored || results.some((r) => r.windowID === e.windowID && r.outcome !== "failed"),
  );
  if (settledAll) await clearManifest();
  return {
    found: true,
    parkedAt: manifest.parkedAt,
    results,
    manifestCleared: settledAll,
  };
}
