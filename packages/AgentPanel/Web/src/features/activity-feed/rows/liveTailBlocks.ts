// The live tail in the shape the transcript will give it: one row per block.

import {
  type ActivityBlock,
  type ActivityEvent,
} from "@/features/activity-feed/useSessionEventsStream";

/** A live row's key: the mirror's own row id, stable across the revisions that
 *  grow one message, so a delta replaces its row instead of adding one. */
export function liveRowKey(event: ActivityEvent): string {
  return event.id ?? `live:${event.index}`;
}

/**
 * The live rows to draw under the thread, oldest first.
 *
 * The mirror runs AHEAD of the file: a transcript line is written after the fact, so
 * the only thing this preview is ever about is the part of the turn the reader cannot
 * see yet. Once the transcript has reached a row, the file is the authority and the
 * preview has nothing left to add for it.
 *
 * A turn is MANY messages, not one. The mirror opens a row per message, finishes it,
 * and moves on, and the transcript is what collects them into a thread. So this is a
 * list rather than a slot: holding one slot and letting each new message overwrite
 * the last is only correct while the file keeps up, and it does not. Measured
 * 2026-09-10 on a live session, the durable stream delivered nothing for ninety
 * seconds while four messages took the slot in turn, so three of them were on screen
 * for a few seconds and then nowhere at all, and the thread appeared to stop moving.
 *
 * What retires a row is therefore two separate things, and neither is a clock:
 *
 * - The file NAMING it. That is the handoff, settled on `messageId` in `onEvent`,
 *   which also retires every row the mirror published before it: the file writes
 *   messages in the order the mirror made them, so naming one says the file has
 *   reached that point in the mirror's own order.
 * - The file moving PAST it, which is what this function decides. A mirror that
 *   stops mid-turn keeps publishing a row whose id never reaches the file, so the
 *   handoff can never fire and the preview sits under a thread that is streaming
 *   perfectly well behind it. Measured 2026-09-09: a three-hour-old finished message
 *   pinned below a live session as a 9,554px block, in a feed that follows its own
 *   bottom.
 *
 * "Past" is measured against the newest transcript row for a message THIS MIRROR
 * never published, because those are the only rows that say the mirror is behind. A
 * row's `ts` is the moment its message began streaming, so a file holding an
 * unmirrored message from that moment or later is not waiting on this one. Two kinds
 * of row are deliberately ignored:
 *
 * - Rows for a message the mirror DID publish. The transcript appends per tool step
 *   and writes a message when it ends, so its row lands at about the instant the next
 *   message starts streaming; counting it would retire the row the mirror is writing
 *   right now on a coin flip. Those rows are the handoff's business, not this one's.
 * - Rows carrying no message at all -- tool results, the reader's own turns. They are
 *   written throughout a turn and belong to no message, so their arrival is not
 *   evidence about which message the file has reached.
 */
export function visibleTails(
  rows: ReadonlyMap<string, ActivityEvent>,
  durable: readonly ActivityEvent[],
  mirrored: ReadonlySet<string>,
): ActivityEvent[] {
  let newestUnmirrored = Number.NEGATIVE_INFINITY;
  for (const event of durable) {
    if (event.messageId === undefined || mirrored.has(event.messageId)) continue;
    if (event.ts > newestUnmirrored) newestUnmirrored = event.ts;
  }
  const visible: ActivityEvent[] = [];
  for (const row of rows.values()) {
    if (row.ts > newestUnmirrored) visible.push(row);
  }
  return visible.sort((left, right) => left.index - right.index);
}

/** The blocks a transcript writes a line for. Anything else rides on the message's last row. */
const CONTENT_KINDS: ReadonlySet<ActivityBlock["kind"]> = new Set(["text", "reasoning", "tool_use"]);

/**
 * The live tail split into one row per content block, less the blocks the transcript already has.
 *
 * The mirror publishes a MESSAGE, and Claude's transcript writes that message one block per line: a
 * thinking line, then a line per tool call. So while a turn streamed, the live row held the whole
 * message while the lines for its finished blocks landed above it, and the reader saw each of them
 * twice. The live row also had a shape no transcript row has: thinking and calls with no prose is a
 * `tool` row, whose heading carries the chip and the call's intent, and the thinking wrapped beside
 * that heading and ran into it.
 *
 * Splitting gives each block the row it will keep, so the hand-off moves nothing. A message's first
 * N blocks are dropped once the transcript holds N lines for it -- never the last block of a message
 * still streaming, which may be the one being written.
 *
 * Each row's id is its message row's key plus the block's index, so dropping earlier blocks does not
 * rename the ones left, and a row the reader collapsed stays collapsed.
 */
export function splitLiveTails(
  tails: readonly ActivityEvent[],
  durable: readonly ActivityEvent[],
): ActivityEvent[] {
  const written = new Map<string, number>();
  for (const event of durable) {
    if (event.messageId === undefined) continue;
    written.set(event.messageId, (written.get(event.messageId) ?? 0) + 1);
  }
  const rows: ActivityEvent[] = [];
  for (const tail of tails) {
    const content = tail.blocks.flatMap((block, index) => (CONTENT_KINDS.has(block.kind) ? [index] : []));
    if (content.length === 0) {
      rows.push(tail);
      continue;
    }
    const rest = tail.blocks.filter((block) => !CONTENT_KINDS.has(block.kind));
    const held = tail.messageId === undefined ? 0 : written.get(tail.messageId) ?? 0;
    const skip = Math.min(held, tail.phase === "complete" ? content.length : content.length - 1);
    content.forEach((blockIndex, position) => {
      if (position < skip) return;
      const block = tail.blocks[blockIndex]!;
      const isLast = position === content.length - 1;
      rows.push({
        ...tail,
        id: `${liveRowKey(tail)}:${blockIndex}`,
        // What the transcript calls a thinking line, so the row is the one it will become.
        type: block.kind === "reasoning" ? "reasoning" : tail.type,
        // A block followed by another has finished, so it renders whole rather than revealing.
        phase: isLast ? tail.phase : "complete",
        blocks: isLast ? [block, ...rest] : [block],
      });
    });
  }
  return rows;
}
