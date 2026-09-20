// Everything the feed renders for one window of events: which rows there are, which
// tool results fold into the call that asked for them, and how one event's blocks
// split between its body and its Raw drawer.

import type { ActivityBlock, ActivityEvent } from "@/features/activity-feed/useSessionEventsStream";
import {
  buildActivityDisplayItems,
  displayRole,
  isCompactionEvent,
  isSkillActivation,
  type DisplayItem,
  type DisplayItemOptions,
} from "@/features/activity-feed/rows/activityDisplayItems";

/** A tool_result that renders inside the tool call it answers. */
export interface PairedToolResult {
  block: ActivityBlock;
  eventIndex: number;
  blockIndex: number;
  includesRawEvent: boolean;
  /** The result event's own metadata, which travels into the tool call's
   *  Raw drawer because the event no longer gets a row of its own. */
  metadata: ActivityBlock[];
  /** Indices, in the result's event, of the image blocks this result returned. */
  images: number[];
}

/**
 * Where the images one tool result returned sit in its event.
 *
 * Matched by `callId` rather than by position: one Claude line can answer several calls at once,
 * and the adapter names each image by the call whose result carried it.
 */
function resultImages(ev: ActivityEvent, callId: string | undefined): number[] {
  if (!callId) return [];
  return ev.blocks.flatMap((block, index) =>
    block.kind === "image" && block.callId === callId ? [index] : [],
  );
}

/** Everything the feed needs to render one window of events. */
export interface FeedLayout {
  items: DisplayItem[];
  /** Indices of the single-event rows that own a collapse toggle. */
  allEventIds: number[];
  /** Lead indices of every clusterable run, folded or not, for the fold-all control. */
  clusterLeadIds: number[];
  /** Keyed by callId. */
  pairedToolResults: Map<string, PairedToolResult>;
}

/**
 * Codex persists reasoning summaries as cumulative snapshots: `[A]`, then
 * `[A, B]`, then `[A, B, C]`. Raw must preserve those source records, but Nice
 * reads them as a sequence and therefore projects the later rows to `B`, then
 * `C`. A discontinuity starts a new sequence, and an exact repeat contributes
 * no row.
 *
 * The first event in a loaded window stays complete. That is the required page
 * boundary anchor when the preceding snapshot is not present; prepending an
 * older page recomputes the projection and turns it into a suffix naturally.
 */
function projectIncrementalReasoning(events: ActivityEvent[]): ActivityEvent[] {
  const projected: ActivityEvent[] = [];
  let previousText: string | null = null;

  for (const event of events) {
    const reasoningBlocks = event.type === "reasoning"
      ? event.blocks.filter((block) => block.kind === "reasoning" && block.text)
      : [];
    if (reasoningBlocks.length !== 1) {
      previousText = null;
      projected.push(event);
      continue;
    }

    const block = reasoningBlocks[0]!;
    const cumulativeText = block.text!.trim();
    if (previousText === null) {
      previousText = cumulativeText;
      projected.push(event);
      continue;
    }
    if (cumulativeText === previousText) continue;

    const prefix = `${previousText}\n\n`;
    previousText = cumulativeText;
    if (!cumulativeText.startsWith(prefix)) {
      projected.push(event);
      continue;
    }

    const suffix = cumulativeText.slice(prefix.length).trim();
    if (!suffix) continue;
    projected.push({
      ...event,
      blocks: event.blocks.map((candidate) =>
        candidate === block ? { ...candidate, text: suffix } : candidate
      ),
    });
  }

  return projected;
}

/**
 * The Nice projection's scaffolding filter: system lines go, except a compaction.
 *
 * Dropping every `system` event is what the filter used to be, and it silently took the
 * compaction banner with it -- a compaction is not a turn, so the adapters emit it as a system
 * line. The banner therefore only ever appeared in Raw, which is the one view nobody reads a
 * thread in, and a reader of a compacted session saw the transcript simply continue at a
 * different size. `CompactionRow` and the sticky-header rules were both already written for it.
 *
 * One banner per compaction, not two. A Claude compaction is TWO records -- the harness's
 * `compact_boundary`, which carries what the context dropped to, and the synthetic user message
 * holding the summary that replaced it -- and both normalize to a compaction block. The first is
 * kept because it is the one with the metadata on it. Raw still draws a row per line, which is
 * the fidelity guarantee Nice leans on.
 */
function contentOnly(events: ActivityEvent[]): ActivityEvent[] {
  const kept: ActivityEvent[] = [];
  let afterCompaction = false;
  for (const event of events) {
    if (isCompactionEvent(event)) {
      if (!afterCompaction) kept.push(event);
      afterCompaction = true;
      continue;
    }
    // A system line between the pair is dropped rather than rendered, so the two banners would
    // still land next to each other: it does not break the run.
    if (event.type === "system") continue;
    afterCompaction = false;
    kept.push(event);
  }
  return kept;
}

// Pair result-only events with their matching tool calls, so a call and its
// output read as one row. Mixed events stay independent: user prose or an
// unmatched result must never be hidden inside someone else's row.
export function buildFeedLayout(
  events: ActivityEvent[],
  options: DisplayItemOptions = {},
): FeedLayout {
  const contentEvents = options.hideSystem ? contentOnly(events) : events;
  const visibleEvents = options.incrementalReasoning
    ? projectIncrementalReasoning(contentEvents)
    : contentEvents;
  const toolCallIds = new Set(
    visibleEvents.flatMap((event) =>
      event.blocks.flatMap((block) =>
        block.kind === "tool_use" && block.callId ? [block.callId] : [],
      ),
    ),
  );
  const pairedToolResults = new Map<string, PairedToolResult>();
  const pairedResultEventIds = new Set<number>();

  for (const event of visibleEvents) {
    const resultBlocks = event.blocks
      .map((block, blockIndex) => ({ block, blockIndex }))
      .filter(({ block }) => block.kind === "tool_result");
    // Metadata does not make an event more than its result: the adapters
    // append Working Directory to nearly every Claude line, and excluding it
    // here left every Claude result stranded in its own row instead of nesting
    // under the call that produced it. Same trap as isCompactionEvent.
    // An image one of those results returned is part of that result, not more than it: a Read of a
    // screenshot is a result made of nothing else.
    const resultCallIds = new Set(resultBlocks.flatMap(({ block }) => block.callId ? [block.callId] : []));
    const isResultOnly = event.blocks.every(
      (block) =>
        block.kind === "tool_result" ||
        block.kind === "raw" ||
        block.kind === "metadata" ||
        (block.kind === "image" && block.callId !== undefined && resultCallIds.has(block.callId)),
    );
    const canPairEveryResult = resultBlocks.every(
      ({ block }) => block.callId && toolCallIds.has(block.callId),
    );
    if (!isResultOnly || resultBlocks.length === 0 || !canPairEveryResult) continue;

    pairedResultEventIds.add(event.index);
    const { folded, hasRawJson } = partitionEventBlocks(event);
    resultBlocks.forEach(({ block, blockIndex }, resultIndex) => {
      // Only the first result of an event carries the event-level raw line and
      // metadata; the rest would just repeat them.
      const isFirst = resultIndex === 0;
      pairedToolResults.set(block.callId!, {
        block,
        eventIndex: event.index,
        blockIndex,
        includesRawEvent: hasRawJson && isFirst,
        metadata: isFirst ? folded : [],
        images: resultImages(event, block.callId),
      });
    });
  }

  const displayEvents = visibleEvents.filter(
    (event) => !pairedResultEventIds.has(event.index),
  );
  const { items, runLeads } = buildActivityDisplayItems(displayEvents, options);
  // Derived from the items rather than the events, so a member of a folded run does
  // not appear to own a collapse toggle it has no row to carry. Run leads are a list of
  // their own because `foldedClusters` folds a run where `collapsed` closes a row, and a
  // run's lead index is also its first row's index.
  const allEventIds: number[] = [];
  for (const item of items) {
    if (item.kind !== "cluster") allEventIds.push(item.ev.index);
  }
  return { items, allEventIds, clusterLeadIds: runLeads, pairedToolResults };
}

/** How one event's blocks split between its visible body and its Raw drawer. */
export interface EventBlockLayout {
  /** Rendered in the event body, carrying each block's original index. A tool result carries the
   *  indices of the images it returned, which are not listed on their own. */
  inline: { block: ActivityBlock; index: number; images?: number[] }[];
  /** Metadata moved into the collapsed Raw drawer. */
  folded: ActivityBlock[];
  /** The event carries a raw block, so Raw JSON nests inside that drawer. */
  hasRawJson: boolean;
}

// Metadata annotates the event's content: token counts, stop reason, and the
// working directory the adapter appends to nearly every Claude line. Three
// bordered cards under every tool call bury the call itself, so metadata folds
// into the Raw drawer alongside the raw line. When metadata is ALL the event
// has (Codex "Agent Message" / "Developer Message" system lines) it is the
// content, and folding it would leave a row with nothing on it.
export function partitionEventBlocks(ev: ActivityEvent): EventBlockLayout {
  const hasContent = ev.blocks.some(
    (block) => block.kind !== "metadata" && block.kind !== "raw",
  );
  const inline: { block: ActivityBlock; index: number; images?: number[] }[] = [];
  const folded: ActivityBlock[] = [];
  let hasRawJson = false;
  const resultCallIds = new Set(
    ev.blocks.flatMap((block) => block.kind === "tool_result" && block.callId ? [block.callId] : []),
  );

  ev.blocks.forEach((block, index) => {
    if (block.kind === "raw") {
      hasRawJson = true;
      return;
    }
    // Drawn inside the result that returned it, the same as when that result pairs into its call.
    if (block.kind === "image" && block.callId !== undefined && resultCallIds.has(block.callId)) {
      return;
    }
    if (block.kind === "tool_result") {
      inline.push({ block, index, images: resultImages(ev, block.callId) });
      return;
    }
    if (block.kind === "metadata" && hasContent) {
      folded.push(block);
      return;
    }
    inline.push({ block, index });
  });

  return { inline, folded, hasRawJson };
}
