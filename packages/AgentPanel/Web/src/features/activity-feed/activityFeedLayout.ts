// Everything the feed renders for one window of events: which rows there are, which
// tool results fold into the call that asked for them, and how one event's blocks
// split between its body and its Raw drawer.

import type { ActivityBlock, ActivityEvent } from "./useSessionEventsStream";
import {
  buildActivityDisplayItems,
  displayRole,
  isSkillActivation,
  type DisplayItem,
  type DisplayItemOptions,
} from "./activityDisplayItems";

/** A tool_result that renders inside the tool call it answers. */
export interface PairedToolResult {
  block: ActivityBlock;
  eventIndex: number;
  blockIndex: number;
  includesRawEvent: boolean;
  /** The result event's own metadata, which travels into the tool call's
   *  Raw drawer because the event no longer gets a row of its own. */
  metadata: ActivityBlock[];
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

// Pair result-only events with their matching tool calls, so a call and its
// output read as one row. Mixed events stay independent: user prose or an
// unmatched result must never be hidden inside someone else's row.
export function buildFeedLayout(
  events: ActivityEvent[],
  options: DisplayItemOptions = {},
): FeedLayout {
  const contentEvents = options.hideSystem
    ? events.filter((event) => event.type !== "system")
    : events;
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
    const isResultOnly = event.blocks.every(
      (block) =>
        block.kind === "tool_result" ||
        block.kind === "raw" ||
        block.kind === "metadata",
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
      });
    });
  }

  const displayEvents = visibleEvents.filter(
    (event) => !pairedResultEventIds.has(event.index),
  );
  const items = buildActivityDisplayItems(displayEvents, options);
  // Derived from the items rather than the events, so a member of a folded cluster
  // does not appear to own a collapse toggle it has no row to carry. Cluster leads
  // are listed separately because their toggle means the opposite thing: membership
  // in `expandedClusters` OPENS a cluster, where membership in `collapsed` closes a
  // row, and one set cannot express both defaults.
  const allEventIds: number[] = [];
  const clusterLeadIds: number[] = [];
  for (const item of items) {
    if (item.kind === "cluster") clusterLeadIds.push(item.events[0]!.index);
    else allEventIds.push(item.ev.index);
  }
  // An OPEN cluster contributes its lead too, or the fold-all control could not
  // close what the viewer just opened.
  for (const lead of options.expandedClusters ?? []) {
    if (allEventIds.includes(lead)) clusterLeadIds.push(lead);
  }
  return { items, allEventIds, clusterLeadIds, pairedToolResults };
}

/** How one event's blocks split between its visible body and its Raw drawer. */
export interface EventBlockLayout {
  /** Rendered in the event body, carrying each block's original index. */
  inline: { block: ActivityBlock; index: number }[];
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
  const inline: { block: ActivityBlock; index: number }[] = [];
  const folded: ActivityBlock[] = [];
  let hasRawJson = false;

  ev.blocks.forEach((block, index) => {
    if (block.kind === "raw") {
      hasRawJson = true;
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
