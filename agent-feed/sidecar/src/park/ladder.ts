// Where each parked window goes, and proof that it will still render there.
//
// Pure geometry. No yabai, no clock, no I/O, so the interesting part is testable
// without moving anything on anyone's screen.
//
// The rules it encodes were measured, not assumed (see
// docs/superpowers/specs/2026-08-25-desktop-park-manifest-design.md):
//
//   - A window renders only while it is on the active Space AND not completely
//     covered. Occlusion is a threshold, not a gradient: one exposed pixel
//     renders at full fidelity, zero exposed pixels stops rendering entirely.
//   - Coverage is computed against the UNION of everything in front, so "no
//     single window contains me" is not enough. Two neighbours together will
//     swallow the window between them.
//   - macOS keeps 40pt of a window on screen horizontally and 32pt vertically
//     and refuses to hide one under the menu bar, so the bulk can hang off an
//     edge while a strip stays addressable.
//
// Because coverage is union-based, offsets have to run monotonically with the
// real stacking order. That is why `plan` takes windows front-to-back and will
// not accept a bare set.

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A window to park, carrying its current frame. Order matters: front first. */
export interface LadderWindow {
  id: number;
  frame: Rect;
}

export interface LadderOptions {
  /** The display to park against, in global top-down coordinates. */
  display: Rect;
  /** How much of each window stays on the display. The exposed strip. */
  strip: number;
  /** Vertical distance between rungs. Each window's exclusive band is this tall. */
  step: number;
  /** Top of the shallowest rung. Clears the menu bar. */
  topMargin: number;
}

export type LadderSide = "left" | "right";

export interface Placement {
  id: number;
  side: LadderSide;
  /** Position in the stacking order, 0 = frontmost. */
  depth: number;
  /** Position within this side's ladder, 0 = shallowest. */
  rung: number;
  x: number;
  y: number;
  /**
   * Area of this window, in square points, that nothing in front of it covers
   * and that lies on the display. Zero means the window would stop rendering,
   * which is a broken plan rather than a tolerable one.
   */
  exposed: number;
}

export interface LadderPlan {
  placements: Placement[];
  /** Windows that did not fit the vertical room available. Never parked. */
  overflow: number[];
  /** Placements whose exposed area came out zero. Empty means the plan is sound. */
  starved: Placement[];
}

/** Rects covering `base` that are not covered by `cut`. Up to four pieces. */
function subtractOne(base: Rect, cut: Rect): Rect[] {
  const x0 = Math.max(base.x, cut.x);
  const y0 = Math.max(base.y, cut.y);
  const x1 = Math.min(base.x + base.w, cut.x + cut.w);
  const y1 = Math.min(base.y + base.h, cut.y + cut.h);
  if (x0 >= x1 || y0 >= y1) return [base]; // no overlap
  const out: Rect[] = [];
  if (base.y < y0) out.push({ x: base.x, y: base.y, w: base.w, h: y0 - base.y });
  if (y1 < base.y + base.h) out.push({ x: base.x, y: y1, w: base.w, h: base.y + base.h - y1 });
  if (base.x < x0) out.push({ x: base.x, y: y0, w: x0 - base.x, h: y1 - y0 });
  if (x1 < base.x + base.w) out.push({ x: x1, y: y0, w: base.x + base.w - x1, h: y1 - y0 });
  return out.filter((r) => r.w > 0 && r.h > 0);
}

function intersect(a: Rect, b: Rect): Rect | null {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  if (x0 >= x1 || y0 >= y1) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * Area of `base` left over after removing everything in `covers`, clipped to
 * `clip`. Exact rather than sampled, because a plan that is wrong by one pixel
 * is a window that does not render.
 */
export function uncoveredArea(base: Rect, covers: readonly Rect[], clip: Rect): number {
  const start = intersect(base, clip);
  if (!start) return 0;
  let pieces: Rect[] = [start];
  for (const cut of covers) {
    if (pieces.length === 0) break;
    pieces = pieces.flatMap((piece) => subtractOne(piece, cut));
  }
  return pieces.reduce((sum, r) => sum + r.w * r.h, 0);
}

/**
 * Lay windows into two ladders, one off each edge of the display.
 *
 * Sides alternate by depth so each side climbs half as far, which both halves the
 * vertical room needed and halves the blast radius when something outside raises
 * a window: a cascade takes out only the rungs above it on its own side.
 *
 * Rungs climb UPWARD with depth, so a deeper window sits higher and its exclusive
 * band is a top edge. Bottom edges would put every band in the Dock's reveal zone.
 */
export function plan(frontToBack: readonly LadderWindow[], options: LadderOptions): LadderPlan {
  const { display, strip, step, topMargin } = options;
  const perSide: Record<LadderSide, LadderWindow[]> = { right: [], left: [] };
  frontToBack.forEach((w, depth) => {
    perSide[depth % 2 === 0 ? "right" : "left"].push(w);
  });

  const placements: Placement[] = [];
  const overflow: number[] = [];
  const depthOf = new Map(frontToBack.map((w, i) => [w.id, i]));

  for (const side of ["right", "left"] as const) {
    const list = perSide[side];
    for (let rung = 0; rung < list.length; rung += 1) {
      const w = list[rung]!;
      // Deeper rungs sit higher, so the top of each is clear of the one in front.
      const top = topMargin + step * (list.length - 1 - rung);
      const bottom = top + w.frame.h;
      if (top < display.y || bottom > display.y + display.h) {
        overflow.push(w.id);
        continue;
      }
      const x = side === "right"
        ? display.x + display.w - strip
        : display.x + strip - w.frame.w;
      placements.push({
        id: w.id,
        side,
        depth: depthOf.get(w.id) ?? 0,
        rung,
        x,
        y: top,
        exposed: 0,
      });
    }
  }

  // Now check the plan against its own rule rather than trusting the arithmetic:
  // for each window, subtract everything that will be in front of it.
  placements.sort((a, b) => a.depth - b.depth);
  const rectOf = new Map(frontToBack.map((w) => [w.id, w.frame]));
  for (let i = 0; i < placements.length; i += 1) {
    const p = placements[i]!;
    const size = rectOf.get(p.id)!;
    const own: Rect = { x: p.x, y: p.y, w: size.w, h: size.h };
    const inFront = placements.slice(0, i).map((q) => {
      const s = rectOf.get(q.id)!;
      return { x: q.x, y: q.y, w: s.w, h: s.h };
    });
    p.exposed = uncoveredArea(own, inFront, display);
  }

  return { placements, overflow, starved: placements.filter((p) => p.exposed <= 0) };
}
