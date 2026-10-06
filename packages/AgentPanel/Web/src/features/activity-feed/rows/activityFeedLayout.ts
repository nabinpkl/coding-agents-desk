// Everything the feed renders for one window of events: which rows there are, which
// tool results fold into the call that asked for them, and how one event's blocks
// split between its body and its Raw drawer.

import type { ActivityBlock, ActivityEvent } from "@/features/activity-feed/useSessionEventsStream";
import {
  buildActivityDisplayItems,
  compactionSummary,
  displayRole,
  isCompactionEvent,
  isSkillActivation,
  type DisplayItemOptions,
  type FeedItem,
} from "@/features/activity-feed/rows/activityDisplayItems";
import { gapsIn, type Gap } from "@/features/activity-feed/data-source/eventPaging";

/**
 * The instructions a skill loaded, folded into the call that loaded them.
 *
 * Claude writes a skill activation as THREE records: the `Skill` call, a `tool_result` saying
 * only `Launching skill: <name>`, and then the whole skill as a separate harness-written user
 * message. That third record is prose inside a `user` record, so it rendered as the reader's own
 * right-aligned card -- several hundred lines of instructions attributed to the person, sitting
 * between the call that loaded them and the work they steered. It is what the call returned, so
 * it belongs inside the call.
 */
export interface SkillBody {
  text: string;
  /** The folded record's own index, metadata and raw line, which travel into the call for the
   *  same reason a paired result's do: it no longer has a row of its own to carry them. */
  eventIndex: number;
  metadata: ActivityBlock[];
  includesRawEvent: boolean;
}

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
  /** Where this call is a `Skill` activation, the skill's own text. */
  skillBody?: SkillBody;
}

/**
 * Pair the tool results carried beside their calls in one event.
 *
 * opencode's completed tool parts are one assistant event, unlike the separate
 * call and result records used by the file-backed adapters. The live tail uses
 * this same helper before the event reaches the durable feed layout, so the
 * result behaves the same before and after handoff.
 */
export function pairSameEventToolResults(event: ActivityEvent): Map<string, PairedToolResult> {
  const callIds = new Set(
    event.blocks.flatMap((block) =>
      block.kind === "tool_use" && block.callId ? [block.callId] : [],
    ),
  );
  const results = new Map<string, PairedToolResult>();
  event.blocks.forEach((block, blockIndex) => {
    if (block.kind !== "tool_result" || block.callId === undefined || !callIds.has(block.callId)) return;
    results.set(block.callId, {
      block,
      eventIndex: event.index,
      blockIndex,
      includesRawEvent: false,
      metadata: [],
      images: resultImages(event, block.callId),
    });
  });
  return results;
}

/** Remove results paired into a call, and their images, from the event's visible body. */
export function withoutPairedToolResults(
  event: ActivityEvent,
  pairedResults: ReadonlyMap<string, PairedToolResult>,
): ActivityEvent {
  if (pairedResults.size === 0) return event;
  return {
    ...event,
    blocks: event.blocks.filter((block) => {
      if (block.kind === "tool_result" || block.kind === "image") {
        return block.callId === undefined || !pairedResults.has(block.callId);
      }
      return true;
    }),
  };
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

/**
 * Whether this event is text the HARNESS wrote as the user.
 *
 * `humanTurn` is the sidecar's answer to "did a person write this line", decided where the raw
 * record still exists and the panel cannot ask again (`transcripts/humanTurns.ts`): Claude marks
 * its own injections `isMeta`, whatever they say. Metadata does not disqualify an event from its
 * shape -- the adapter appends Working Directory to nearly every Claude line -- which is the same
 * trap `isResultOnly` and `isCompactionEvent` each had to be widened for.
 */
function isHarnessUserText(ev: ActivityEvent): boolean {
  return ev.type === "user" &&
    ev.humanTurn !== true &&
    ev.blocks.some((block) => block.kind === "text" && (block.text ?? "").trim() !== "") &&
    ev.blocks.every(
      (block) => block.kind === "text" || block.kind === "metadata" || block.kind === "raw",
    );
}

/** Everything the feed needs to render one window of events. */
export interface FeedLayout {
  /** The rows, with a gap row wherever the held ranges leave rows out. */
  items: FeedItem[];
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
 * kept because it is the one with the metadata on it, and it takes the second's summary, which is
 * what the banner opens to. Raw still draws a row per line, which is the fidelity guarantee Nice
 * leans on.
 */
function contentOnly(events: ActivityEvent[]): ActivityEvent[] {
  const kept: ActivityEvent[] = [];
  // Where in `kept` the current run of compaction records put its one banner.
  let banner: number | null = null;
  for (const event of events) {
    if (isCompactionEvent(event)) {
      if (banner === null) {
        banner = kept.length;
        kept.push(event);
        continue;
      }
      const summary = compactionSummary(event);
      if (summary !== null && compactionSummary(kept[banner]!) === null) {
        kept[banner] = withCompactionSummary(kept[banner]!, summary);
      }
      continue;
    }
    // A system line between the pair is dropped rather than rendered, so the two banners would
    // still land next to each other: it does not break the run.
    if (event.type === "system") continue;
    banner = null;
    kept.push(event);
  }
  return kept;
}

function withCompactionSummary(event: ActivityEvent, summary: string): ActivityEvent {
  return {
    ...event,
    blocks: event.blocks.map((block) => block.kind === "compaction" ? { ...block, text: summary } : block),
  };
}

// Pair result-only events with their matching tool calls, so a call and its
// output read as one row. Also pair a result that arrived in the same event as
// its call, which is how opencode's completed tool parts arrive. Mixed result
// events stay independent: user prose or an unmatched result must never be
// hidden inside someone else's row.
export function buildFeedLayout(
  events: ActivityEvent[],
  options: Omit<DisplayItemOptions, "gaps"> = {},
): FeedLayout {
  // On every held row, before the view leaves any out: a hidden system line between two shown rows
  // is what the second one's `previous` names, and that is no gap.
  const gaps = gapsIn(events);
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
  const pairedResultCallIdsByEvent = new Map<number, Map<string, PairedToolResult>>();

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

    if (isResultOnly && resultBlocks.length > 0 && canPairEveryResult) {
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
      continue;
    }

    // opencode emits a completed tool call and its result as adjacent blocks in
    // one assistant event. Pair those results here too, but leave a result that
    // shares an event with unrelated prose alone: that text is its own row.
    const sameEventResults = pairSameEventToolResults(event);
    if (sameEventResults.size === 0) continue;
    pairedResultCallIdsByEvent.set(event.index, sameEventResults);
    for (const [callId, result] of sameEventResults) pairedToolResults.set(callId, result);
  }

  // A skill's body carries no `callId` -- the harness gives it none -- so it is found by
  // POSITION: the visible event straight after the `Launching skill:` result of a `Skill` call.
  // Anything less exact is left alone. A body that is not where it should be keeps its own row
  // rather than being folded into whichever call happens to sit above it, because the failure of
  // guessing here is a reader's own message disappearing into a tool row.
  const skillCallIds = new Set(
    visibleEvents.flatMap((event) =>
      event.blocks.flatMap((block) =>
        block.kind === "tool_use" && block.tool === "Skill" && block.callId ? [block.callId] : [],
      ),
    ),
  );
  for (let position = 1; position < visibleEvents.length; position++) {
    const body = visibleEvents[position]!;
    if (!isHarnessUserText(body)) continue;
    // Straight after means with nothing missing between: across a gap, whatever answered the call
    // may be a line that is not held.
    if (gapBetween(gaps, visibleEvents[position - 1]!.index, body.index)) continue;
    const answered = visibleEvents[position - 1]!.blocks.flatMap((block) =>
      block.kind === "tool_result" && block.callId && skillCallIds.has(block.callId)
        ? [block.callId]
        : [],
    );
    // Exactly one: two skills answered on one line leave nothing to say which body is whose.
    if (answered.length !== 1) continue;
    const paired = pairedToolResults.get(answered[0]!);
    if (!paired) continue;
    const text = body.blocks
      .flatMap((block) => (block.kind === "text" && block.text ? [block.text] : []))
      .join("\n\n")
      .trim();
    if (!text) continue;
    const { folded, hasRawJson } = partitionEventBlocks(body);
    paired.skillBody = {
      text,
      eventIndex: body.index,
      metadata: folded,
      includesRawEvent: hasRawJson,
    };
    pairedResultEventIds.add(body.index);
  }

  const displayEvents = visibleEvents
    .filter((event) => !pairedResultEventIds.has(event.index))
    .map((event) => withoutPairedToolResults(event, pairedResultCallIdsByEvent.get(event.index) ?? new Map()));
  const { items, runLeads } = buildActivityDisplayItems(displayEvents, { ...options, gaps });
  // Derived from the items rather than the events, so a member of a folded run does
  // not appear to own a collapse toggle it has no row to carry. Run leads are a list of
  // their own because `foldedClusters` folds a run where `collapsed` closes a row, and a
  // run's lead index is also its first row's index.
  const allEventIds: number[] = [];
  for (const item of items) {
    if (item.kind !== "cluster" && item.kind !== "gap") allEventIds.push(item.ev.index);
  }
  return { items, allEventIds, clusterLeadIds: runLeads, pairedToolResults };
}

/** Whether a gap lies between the held rows at `older` and `newer`. */
function gapBetween(gaps: readonly Gap[], older: number, newer: number): boolean {
  return gaps.some((gap) => gap.below > older && gap.below <= newer);
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
