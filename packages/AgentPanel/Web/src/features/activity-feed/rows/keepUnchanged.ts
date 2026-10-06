// Carrying unchanged rows across a rebuilt layout, so a memoized row can tell it has nothing to do.
//
// `buildFeedLayout` builds every display item and every paired result anew each time a transcript
// line lands. The events inside them are mostly the same objects as before, but the wrappers are
// not, so a row compared by reference re-rendered for every line in the thread. These hand back
// the previous object wherever the new one says the same thing, and the new one only where it
// does not.

import type { ActivityEvent } from "@/features/activity-feed/useSessionEventsStream";
import { itemKey, type FeedItem } from "@/features/activity-feed/rows/activityDisplayItems";
import type { PairedToolResult } from "@/features/activity-feed/rows/activityFeedLayout";

function sameList<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * Whether two events render the same.
 *
 * By reference first, which is nearly always the answer. The layout rebuilds an event only to
 * drop blocks from it (results paired into their call) or to replace one block, so the fallback
 * compares the wrapper's fields and its blocks one by one, each by reference.
 */
function sameEvent(left: ActivityEvent, right: ActivityEvent): boolean {
  if (left === right) return true;
  const leftKeys = Object.keys(left) as (keyof ActivityEvent)[];
  if (leftKeys.length !== Object.keys(right).length) return false;
  return leftKeys.every((key) =>
    key === "blocks" ? sameList(left.blocks, right.blocks) : left[key] === right[key]);
}

function sameItem(left: FeedItem, right: FeedItem): boolean {
  if (left.kind === "gap" || right.kind === "gap") {
    return left.kind === "gap" && right.kind === "gap" && left.above === right.above && left.below === right.below;
  }
  if (left.kind === "cluster" || right.kind === "cluster") {
    return left.kind === "cluster" && right.kind === "cluster"
      && left.events.length === right.events.length
      && left.events.every((event, index) => sameEvent(event, right.events[index]!));
  }
  if (left.kind !== right.kind || !sameEvent(left.ev, right.ev)) return false;
  return left.kind !== "segment_event" || right.kind !== "segment_event"
    || (left.isFirst === right.isFirst && left.isLast === right.isLast);
}

/** `next`, with each item that matches the previous one at its key replaced by that previous one. */
export function keepUnchangedItems(previous: readonly FeedItem[], next: FeedItem[]): FeedItem[] {
  if (previous.length === 0) return next;
  const byKey = new Map(previous.map((item) => [itemKey(item), item]));
  let reused = 0;
  const kept = next.map((item) => {
    const before = byKey.get(itemKey(item));
    if (before === undefined || !sameItem(before, item)) return item;
    reused += 1;
    return before;
  });
  return reused === 0 ? next : kept;
}

function samePair(left: PairedToolResult, right: PairedToolResult): boolean {
  const leftSkill = left.skillBody;
  const rightSkill = right.skillBody;
  return left.block === right.block
    && left.eventIndex === right.eventIndex
    && left.blockIndex === right.blockIndex
    && left.includesRawEvent === right.includesRawEvent
    && sameList(left.metadata, right.metadata)
    && sameList(left.images, right.images)
    && (leftSkill === rightSkill || (
      leftSkill !== undefined && rightSkill !== undefined
      && leftSkill.text === rightSkill.text
      && leftSkill.eventIndex === rightSkill.eventIndex
      && leftSkill.includesRawEvent === rightSkill.includesRawEvent
      && sameList(leftSkill.metadata, rightSkill.metadata)
    ));
}

/** `next`, with each result that matches the previous one for its call replaced by that previous one. */
export function keepUnchangedPairs(
  previous: ReadonlyMap<string, PairedToolResult>,
  next: Map<string, PairedToolResult>,
): Map<string, PairedToolResult> {
  for (const [callId, result] of next) {
    const before = previous.get(callId);
    if (before !== undefined && before !== result && samePair(before, result)) next.set(callId, before);
  }
  return next;
}
