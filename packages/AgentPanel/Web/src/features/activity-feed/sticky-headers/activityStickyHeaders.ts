/**
 * Which rows the thread pins to the top of the scroll area, as pure functions
 * of scroll position and row geometry.
 *
 * Extracted from the feed's render path so the engagement rules are testable
 * without a virtualizer: in jsdom every element measures 0px, so the rules
 * could only ever be exercised through the live DOM before.
 */

/** The subset of a virtualizer measurement these rules need. */
export interface StickyMeasurement {
  start: number;
  size: number;
}

/** The subset of a DisplayItem these rules need. */
export interface StickyRow {
  kind: string;
  ev?: { humanTurn?: true; blocks?: readonly { kind: string; text?: string }[] };
}

/**
 * A prompt that is only a slash command: `/compact`, `/rename Title`. A path such as
 * `/Users/dev/x` is prose, since the token after the slash runs into another slash.
 */
const SLASH_COMMAND = /^\/[A-Za-z][\w:-]*(\s|$)/;

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
  return !SLASH_COMMAND.test(text?.trim() ?? "");
}

/**
 * How much of a row's top must be hidden before a bar may represent it.
 *
 * Below this, the row's own heading is still readable on screen and a bar
 * would restate it while covering it.
 */
export const HEADER_OBSCURED_PX = 24;

/** Last row a person wrote whose heading has passed above `edge`, or null. */
function lastUserAbove(
  rows: readonly StickyRow[],
  measurements: readonly StickyMeasurement[],
  edge: number,
): number | null {
  const limit = Math.min(rows.length, measurements.length);
  let best: number | null = null;
  for (let index = 0; index < limit; index++) {
    const measurement = measurements[index]!;
    if (measurement.start + HEADER_OBSCURED_PX > edge) break;
    if (isPersonRow(rows[index]!)) best = index;
  }
  return best;
}

/**
 * Index of the user row to pin, or null for none.
 *
 * Two passes, because the bar occludes the top of the viewport and therefore
 * changes its own answer. The first pass ignores the bar and asks whether ANY
 * user heading has scrolled off the top; if none has, there is nothing to
 * remind the viewer of and no bar is drawn. That is what keeps a thread at rest
 * bar-free, including one whose whole content fits and never scrolls.
 *
 * Only once a bar is justified does its height become real, so the second pass
 * re-asks with the bar's own bottom edge. This is what makes the bar flip to an
 * incoming turn exactly as that turn's heading slides behind it, rather than
 * naming the previous turn until the heading clears the bar's full height.
 *
 * Doing it in one pass fails either way round: with the bar's height included
 * throughout, a resting thread pins a bar over the row it is restating; with it
 * excluded throughout, the bar goes blank for the height of the bar between
 * turns.
 */
export function selectStickyUserIndex(
  rows: readonly StickyRow[],
  measurements: readonly StickyMeasurement[],
  scrollTop: number,
  stickyHeight: number,
): number | null {
  const unoccluded = lastUserAbove(rows, measurements, scrollTop);
  if (unoccluded === null) return null;
  return lastUserAbove(rows, measurements, scrollTop + stickyHeight) ?? unoccluded;
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
    // would be meaningless.
    if (rows[index]!.kind === "compaction") return null;
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
