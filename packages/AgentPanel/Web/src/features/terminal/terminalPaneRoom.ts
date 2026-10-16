// How tall a terminal pane may grow on its own before it crowds out the transcript above it.
//
// A pane under a transcript sizes itself to the rows its program has drawn, up to a share of the
// session's column. A program that fills its screen (opencode streaming a turn) takes all of that
// share, and the composer around the pane takes most of what is left: measured in an arena lane,
// the transcript was left 58px, every pixel of it under its pinned prompt header, so no wheel over
// the transcript could reach the scroller beneath. The pane growing by itself now stops where the
// transcript would drop below its floor. A reader's own drag is not held to this.

/** What the transcript keeps: its pinned prompt header, and a few lines under it to scroll. */
export const TRANSCRIPT_FLOOR = 180;

/**
 * The tallest `pane` may make itself and still leave the transcript its floor, or null where the
 * pane does not sit in `column` and there is nothing to measure.
 *
 * The column holds the transcript, which takes whatever is left, beside rows that keep their own
 * height (a header) and the block the pane sits in, with the composer around the pane. So the
 * transcript's room is the column less those, and the pane may grow until that room is the floor.
 */
export function paneRoomBesideTranscript(pane: HTMLElement, column: HTMLElement): number | null {
  let block: HTMLElement = pane;
  while (block.parentElement && block.parentElement !== column) block = block.parentElement;
  if (block.parentElement !== column) return null;
  let fixed = 0;
  for (const child of column.children) {
    if (child === block || !(child instanceof HTMLElement)) continue;
    if ((Number.parseFloat(getComputedStyle(child).flexGrow) || 0) === 0) fixed += child.offsetHeight;
  }
  const around = block.offsetHeight - pane.offsetHeight;
  return column.clientHeight - fixed - around - TRANSCRIPT_FLOOR;
}
