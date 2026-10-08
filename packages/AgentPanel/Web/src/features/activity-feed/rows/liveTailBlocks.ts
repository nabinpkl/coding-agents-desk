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

/** The blocks a transcript writes a line for. Anything else rides on the message's last row. */
const CONTENT_KINDS: ReadonlySet<ActivityBlock["kind"]> = new Set(["text", "reasoning", "tool_use"]);

/**
 * The live rows the transcript has not taken over yet, decided from what both sources hold now.
 *
 * Two rules, and both are about the file rather than a clock:
 *
 * - **A message it names, and everything before it.** Once the file carries a message the mirror
 *   finished, the file is the authority for it, and for every row the mirror published before it:
 *   the file writes messages in the mirror's own order, so reaching one is reaching all of them.
 *   That retires the mirror's tool-result rows too, which belong to no message and so can never be
 *   named themselves. Only a FINISHED live row is named: the file writes a message one line per
 *   block, and a later line can trail the first by seconds (a call's line, 4s after its prose's),
 *   so taking the first line as the handoff would drop blocks the file has not written yet. Those
 *   lines are `splitLiveTails`' business, which drops each block as its line lands.
 *   A row the mirror still calls streaming is named too once the file holds a line for every
 *   block it has: a line is written only after its message ended (see `splitLiveTails`), so that
 *   row is a mirror that lost the message's end, and it would otherwise be held for good.
 * - **Results it already pairs.** A tool-result row whose every result the file already carries is
 *   on screen twice -- once under its call, once loose below the thread -- until the next message
 *   is named, which on a long tool step is a long time.
 *
 * Run at every transition -- a durable row arriving, a snapshot, a live row arriving or finishing
 * -- because either side can be the late one. It used to run only when a durable row arrived, so a
 * live row that finished after its line landed, or that arrived after the snapshot already held
 * it, was never retired: measured 2026-10-05, a session opened after its turn ended drew its tool
 * results again as loose RESULT rows below the final reply, and kept them.
 */
export function retireLiveRows(
  liveRows: Map<string, ActivityEvent>,
  durable: Iterable<ActivityEvent>,
): Map<string, ActivityEvent> {
  if (liveRows.size === 0) return liveRows;
  const written = new Map<string, number>();
  const results = new Set<string>();
  for (const event of durable) {
    if (event.phase === "complete" && event.messageId !== undefined) {
      written.set(event.messageId, (written.get(event.messageId) ?? 0) + 1);
    }
    for (const block of event.blocks) {
      if (block.kind === "tool_result" && block.callId !== undefined) results.add(block.callId);
    }
  }
  let reached = Number.NEGATIVE_INFINITY;
  for (const row of liveRows.values()) {
    if (row.messageId === undefined) continue;
    const lines = written.get(row.messageId) ?? 0;
    if (lines === 0) continue;
    const blocks = row.blocks.filter((block) => CONTENT_KINDS.has(block.kind)).length;
    if (row.phase === "complete" || lines >= blocks) reached = Math.max(reached, row.index);
  }
  const paired = (row: ActivityEvent) =>
    row.blocks.length > 0 &&
    row.blocks.every((block) => block.kind === "tool_result" && block.callId !== undefined && results.has(block.callId));
  const kept = [...liveRows].filter(([, row]) => row.index > reached && !paired(row));
  return kept.length === liveRows.size ? liveRows : new Map(kept);
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
 * - The file NAMING it. That is the handoff, `retireLiveRows` above, which also
 *   retires every row the mirror published before it.
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
 * N blocks are dropped once the transcript holds N lines for it, the last one included, whatever
 * phase the mirror says the message is in. Claude writes a message's lines only once the message
 * has ended: every line carries the message's final `stop_reason` (measured 2026-10-08 across the
 * fifteen newest transcripts, 23,341 assistant lines and 8 without one). So a line is never the
 * block being written, and a mirror row still marked streaming whose lines are all in the file is
 * a mirror that lost the message's end. That happens when the proxy observer's connection drops
 * mid-message: measured 2026-10-08, the observer ended at 00:55:17.725, the thinking line landed at
 * 00:55:17.708 and the text line at 00:55:18.459, and the row kept its thinking under the finished
 * reply for good, below the text and repeating the thinking row above it.
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
    const skip = Math.min(held, content.length);
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
