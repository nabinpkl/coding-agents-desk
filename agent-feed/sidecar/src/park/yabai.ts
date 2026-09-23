// The whole platform surface the park needs, and it is a subprocess.
//
// Everything here was measured to work with SIP enabled: `query`, `--space`, and
// `--move` need no scripting addition. `--raise` does, and fails outright on a
// SIP-enabled Mac, which is why nothing in the park depends on setting stacking
// order. It only reads it.
//
// The one load-bearing undocumented behaviour: **`query --windows` returns
// windows in front-to-back stacking order.** Verified against
// `CGWindowListCopyWindowInfo` with six windows through a non-trivial shuffle.
// yabai does not promise this. If a future version changes it the ladder starves
// its middle rungs silently, so pin the version and treat the ordering as a
// contract this file depends on rather than an incidental detail.

import { config } from "@/config/config";
import type { Rect } from "@/park/ladder";

export interface YabaiWindow {
  id: number;
  pid: number;
  app: string;
  title: string;
  frame: Rect;
  space: number;
  display: number;
  layer: string;
  subrole: string;
  opacity: number;
  isVisible: boolean;
  isMinimized: boolean;
  isHidden: boolean;
  isSticky: boolean;
  isFloating: boolean;
  hasAxReference: boolean;
}

export class YabaiUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "YabaiUnavailable";
  }
}

async function run(args: string[]): Promise<string> {
  const bin = config.yabaiPath;
  if (!bin) {
    throw new YabaiUnavailable(
      "no yabai binary found; set AGENT_FEED_YABAI_PATH to an absolute path",
    );
  }
  const proc = Bun.spawn([bin, ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    throw new YabaiUnavailable(`yabai ${args.join(" ")} exited ${code}: ${err.trim() || out.trim()}`);
  }
  return out;
}

async function query<T>(args: string[]): Promise<T> {
  const text = await run(["-m", "query", ...args]);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new YabaiUnavailable(`yabai query returned non-JSON: ${text.slice(0, 200)}`);
  }
}

interface RawWindow {
  id: number;
  pid: number;
  app: string;
  title: string;
  frame: { x: number; y: number; w: number; h: number };
  space: number;
  display: number;
  layer: string;
  subrole: string;
  opacity: number;
  "is-visible": boolean;
  "is-minimized": boolean;
  "is-hidden": boolean;
  "is-sticky": boolean;
  "is-floating": boolean;
  "has-ax-reference": boolean;
}

function shape(raw: RawWindow): YabaiWindow {
  return {
    id: raw.id,
    pid: raw.pid,
    app: raw.app,
    title: raw.title,
    frame: { x: raw.frame.x, y: raw.frame.y, w: raw.frame.w, h: raw.frame.h },
    space: raw.space,
    display: raw.display,
    layer: raw.layer,
    subrole: raw.subrole,
    opacity: raw.opacity,
    isVisible: raw["is-visible"],
    isMinimized: raw["is-minimized"],
    isHidden: raw["is-hidden"],
    isSticky: raw["is-sticky"],
    isFloating: raw["is-floating"],
    hasAxReference: raw["has-ax-reference"],
  };
}

/** Every window yabai tracks, front-to-back. Order is the ladder's only hard input. */
export async function windows(): Promise<YabaiWindow[]> {
  return (await query<RawWindow[]>(["--windows"])).map(shape);
}

export async function activeSpace(): Promise<{ index: number; id: number; display: number }> {
  const s = await query<{ index: number; id: number; display: number }>(["--spaces", "--space"]);
  return { index: s.index, id: s.id, display: s.display };
}

export interface YabaiSpace {
  index: number;
  id: number;
  /** Durable identity. The index shifts when Desktops are added or reordered. */
  uuid: string;
  display: number;
}

export async function spaces(): Promise<YabaiSpace[]> {
  const list = await query<{ index: number; id: number; uuid: string; display: number }[]>(["--spaces"]);
  return list.map((s) => ({ index: s.index, id: s.id, uuid: s.uuid, display: s.display }));
}

export async function displays(): Promise<{ index: number; frame: Rect }[]> {
  const list = await query<{ index: number; frame: Rect }[]>(["--displays"]);
  return list.map((d) => ({ index: d.index, frame: d.frame }));
}

async function windowById(id: number): Promise<YabaiWindow | null> {
  try {
    return shape(await query<RawWindow>(["--windows", "--window", String(id)]));
  } catch {
    return null;
  }
}

export interface MoveOutcome {
  id: number;
  ok: boolean;
  /** What the window actually reports afterwards. A move can silently not take. */
  observed: { space: number; frame: Rect } | null;
  reason?: string;
}

/**
 * Move a window to a Space and confirm it landed.
 *
 * Verified rather than fire-and-forget on purpose: the frame call below is
 * clamped by macOS (asking for x=2400 on an 1800pt display yields x=1760), so a
 * call returning cleanly is not evidence the window went where it was told.
 */
export async function moveToSpace(id: number, spaceIndex: number): Promise<MoveOutcome> {
  try {
    await run(["-m", "window", String(id), "--space", String(spaceIndex)]);
  } catch (error) {
    return { id, ok: false, observed: null, reason: (error as Error).message };
  }
  const after = await windowById(id);
  if (!after) return { id, ok: false, observed: null, reason: "window vanished after the move" };
  return {
    id,
    ok: after.space === spaceIndex,
    observed: { space: after.space, frame: after.frame },
  };
}

/** Position a window and report where it actually landed after the clamp. */
export async function moveTo(id: number, x: number, y: number): Promise<MoveOutcome> {
  try {
    await run(["-m", "window", String(id), "--move", `abs:${Math.round(x)}:${Math.round(y)}`]);
  } catch (error) {
    return { id, ok: false, observed: null, reason: (error as Error).message };
  }
  const after = await windowById(id);
  if (!after) return { id, ok: false, observed: null, reason: "window vanished after the move" };
  const landed = Math.abs(after.frame.x - x) < 1 && Math.abs(after.frame.y - y) < 1;
  return {
    id,
    ok: landed,
    observed: { space: after.space, frame: after.frame },
    reason: landed ? undefined : `clamped to ${after.frame.x},${after.frame.y}`,
  };
}

/**
 * Resize a window and report the size it actually took.
 *
 * Verified for the same reason `moveTo` is: macOS clamps a window to whatever
 * its app is willing to be, and a minimum-size app answers a 2560pt request
 * with its own floor while yabai still exits 0.
 */
export async function resizeTo(id: number, w: number, h: number): Promise<MoveOutcome> {
  try {
    await run(["-m", "window", String(id), "--resize", `abs:${Math.round(w)}:${Math.round(h)}`]);
  } catch (error) {
    return { id, ok: false, observed: null, reason: (error as Error).message };
  }
  const after = await windowById(id);
  if (!after) return { id, ok: false, observed: null, reason: "window vanished after the resize" };
  const landed = Math.abs(after.frame.w - w) < 1 && Math.abs(after.frame.h - h) < 1;
  return {
    id,
    ok: landed,
    observed: { space: after.space, frame: after.frame },
    reason: landed ? undefined : `clamped to ${after.frame.w}x${after.frame.h}`,
  };
}

/**
 * The candidates a park would touch: ordinary windows on a real Desktop.
 *
 * Excludes minimized and hidden windows (they have no surface to render),
 * sticky windows (they are on every Space already), and anything without an AX
 * reference, which in practice is an app's transparent helper surfaces.
 */
export function parkable(all: readonly YabaiWindow[]): YabaiWindow[] {
  return all.filter(
    (w) =>
      w.layer === "normal"
      && w.subrole === "AXStandardWindow"
      && !w.isMinimized
      && !w.isHidden
      && !w.isSticky
      && w.hasAxReference
      && w.frame.w > 0
      && w.frame.h > 0,
  );
}
