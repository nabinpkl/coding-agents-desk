/**
 * Which rows the thread pins to the top of the scroll area, as pure functions
 * of scroll position and row geometry.
 *
 * Extracted from the feed's render path so the engagement rules are testable
 * without a virtualizer: in jsdom every element measures 0px, so the rules
 * could only ever be exercised through the live DOM before.
 */

import { isSaidText } from "@agentdesk/agent-feed-wire";

/** The subset of a virtualizer measurement these rules need. */
export interface StickyMeasurement {
  start: number;
  size: number;
}

/** The subset of a feed row these rules need. A gap row carries the held row under it. */
export interface StickyRow {
  kind: string;
  ev?: { humanTurn?: true; blocks?: readonly { kind: string; text?: string }[] };
  below?: number;
}

/**
 * Whether the user bar may stand for this row.
 *
 * A `user` row is not always a person: a slash command's echo and its stdout, a task notification
 * and a system reminder are all user rows. Pinning one of those after `/compact` put
 * `<local-command-stdout>` in the bar where the last thing the reader said belonged. The sidecar
 * decides which lines a person wrote (`humanTurn`), and this reads that rather than asking again.
 *
 * A person typing `/compact` is flagged as a turn too, and it is still a command rather than
 * something they said, so the bar passes over it to the message before.
 */
function isPersonRow(row: StickyRow): boolean {
  if (row.kind !== "user" || row.ev?.humanTurn !== true) return false;
  const text = row.ev.blocks?.find((block) => block.kind === "text" && block.text?.trim())?.text;
  return isSaidText(text ?? "");
}

/**
 * How much of a row's top must be hidden before a bar may represent it.
 *
 * Below this, the row's own heading is still readable on screen and a bar
 * would restate it while covering it.
 */
export const HEADER_OBSCURED_PX = 24;

/**
 * The last row a person wrote whose heading has passed above `edge`, within the range of held rows
 * that `edge` is in, and the row that range starts at.
 *
 * A gap ends the search: a message above it is not the last one said, since whatever the gap stands
 * for is unread and may hold a newer one.
 */
function lastUserAbove(
  rows: readonly StickyRow[],
  measurements: readonly StickyMeasurement[],
  edge: number,
): { index: number | null; rangeStart: number } {
  const limit = Math.min(rows.length, measurements.length);
  let best: number | null = null;
  let rangeStart = 0;
  for (let index = 0; index < limit; index++) {
    const measurement = measurements[index]!;
    if (measurement.start + HEADER_OBSCURED_PX > edge) break;
    const row = rows[index]!;
    if (row.kind === "gap") {
      best = null;
      rangeStart = index + 1;
    } else if (isPersonRow(row)) {
      best = index;
    }
  }
  return { index: best, rangeStart };
}

/**
 * What the user bar stands for: a held row, the last message said before a position (which the
 * sidecar is asked for), or nothing.
 */
export type UserBar = { row: number } | { before: number } | null;

/**
 * What the user bar stands for at `scrollTop`: the last message the reader said above the top of
 * the viewport (ADR-0125).
 *
 * Found among the held rows of the range the top is in, when that range holds one above it.
 * When it does not, the message is above where the range starts, and the answer is that position
 * for the sidecar to walk back from: the row under the gap that opens the range, or `oldestStart`
 * for the oldest range. Null when nothing is above, which is a range that starts the session, or
 * an `oldestStart` of null for a source the sidecar cannot be asked about.
 *
 * Two passes, because the bar occludes the top of the viewport and therefore changes its own
 * answer. The first ignores the bar and asks whether anything the reader said is above the top at
 * all; if nothing is, no bar is drawn, which is what keeps a thread at rest bar-free, including one
 * whose whole content fits and never scrolls. Only once a bar is justified does its height become
 * real, so the second pass re-asks with the bar's own bottom edge. This is what makes the bar flip
 * to an incoming turn exactly as that turn's heading slides behind it, rather than naming the
 * previous turn until the heading clears the bar's full height.
 *
 * Doing it in one pass fails either way round: with the bar's height included throughout, a
 * resting thread pins a bar over the row it is restating; with it excluded throughout, the bar
 * goes blank for the height of the bar between turns.
 */
export function selectUserBar(
  rows: readonly StickyRow[],
  measurements: readonly StickyMeasurement[],
  scrollTop: number,
  stickyHeight: number,
  oldestStart: number | null,
): UserBar {
  const unoccluded = lastUserAbove(rows, measurements, scrollTop);
  const occluded = lastUserAbove(rows, measurements, scrollTop + stickyHeight).index;
  if (unoccluded.index !== null) return { row: occluded ?? unoccluded.index };
  const before = rangeStartPosition(rows, unoccluded.rangeStart, oldestStart);
  if (before === null) return null;
  return occluded !== null ? { row: occluded } : { before };
}

/** Where the range starting at row `rangeStart` begins in the transcript, or null when nothing precedes it. */
function rangeStartPosition(
  rows: readonly StickyRow[],
  rangeStart: number,
  oldestStart: number | null,
): number | null {
  if (oldestStart === null) return null;
  const gap = rangeStart > 0 ? rows[rangeStart - 1] : undefined;
  if (gap?.kind === "gap") return gap.below ?? null;
  return oldestStart > 0 ? oldestStart : null;
}

/**
 * Index of the row straddling the top of the viewport, or null for none.
 *
 * This is the row whose heading has gone behind the bars while its content is
 * still on screen, so the viewer can see output without seeing whose it is.
 */
export function selectStickyCurrentIndex(
  rows: readonly StickyRow[],
  measurements: readonly StickyMeasurement[],
  scrollTop: number,
  userStickyHeight: number,
  stickyUserIndex: number | null,
): number | null {
  const limit = Math.min(rows.length, measurements.length);
  const threshold = scrollTop + userStickyHeight;
  for (let index = 0; index < limit; index++) {
    const measurement = measurements[index]!;
    if (measurement.start > threshold) break;
    if (measurement.start + measurement.size <= threshold) continue;
    if (threshold - measurement.start < HEADER_OBSCURED_PX) return null;
    // Compaction banners are milestones, not turns, so a role chip for one
    // would be meaningless; a gap stands for rows that are not loaded.
    if (rows[index]!.kind === "compaction" || rows[index]!.kind === "gap") return null;
    // The primary bar already stands for this row.
    if (stickyUserIndex === index) return null;
    return index;
  }
  return null;
}

/**
 * Scroll offset that lands `measurement`'s row at the top of the viewport,
 * clear of any bar that will still be pinned once the scroll settles.
 *
 * Jumping to a user row disengages its own bar (its heading becomes visible
 * again), so reserving space for one would leave a blank band above the row.
 * Jumping to a non-user row leaves the user bar up, so that space is real.
 */
export function jumpScrollTop(measurement: StickyMeasurement, reservedHeight: number): number {
  return Math.max(0, measurement.start - reservedHeight);
}
