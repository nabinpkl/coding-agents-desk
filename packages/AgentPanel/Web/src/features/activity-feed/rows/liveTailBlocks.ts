// The live tail in the shape the transcript will give it: one row per block.

import {
  liveRowKey,
  type ActivityBlock,
  type ActivityEvent,
} from "@/features/activity-feed/useSessionEventsStream";

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
