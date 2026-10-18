"use client";

// One virtualised row of the transcript, whichever kind of row it turns out to be.
//
// The positioning wrapper is here too, because the absolute placement and the measuring
// ref are what make it a virtualised row rather than a row.

import { memo, useMemo } from "react";
import type { ActivityEvent } from "@/features/activity-feed/useSessionEventsStream";
import { liveRowKey } from "@/features/activity-feed/rows/liveTailBlocks";
import { itemEvents, type FeedItem, type GapItem } from "@/features/activity-feed/rows/activityDisplayItems";
import { GapRow } from "@/features/activity-feed/rows/GapRow";
import type { PairedToolResult } from "@/features/activity-feed/rows/activityFeedLayout";
import {
  ClusterRow,
  CompactionRow,
  LiveTailRow,
  SegmentEventRow,
  UserRow,
  type EventRowContext,
} from "@/features/activity-feed/blocks/ActivityEventRows";

/**
 * Memoized, and every prop is one that holds still while the thread streams: the row's item, its
 * offset, two booleans, and callbacks that never change. The feed re-renders on every live delta
 * and every scroll event, and before this each of those re-rendered every visible row in every
 * open card. Measured 2026-10-05 on a canvas of six open cards: with three streaming, 1,867 row
 * renders for 137 feed renders in 25 seconds, nearly all of them rows whose content had not moved;
 * scrolling all six for 20 seconds, 28,255 row renders before and 66 after, and the renderer
 * process from 46% of a core to 33%.
 *
 * So the collapse and highlight state arrive as booleans for THIS row rather than as the sets they
 * come from: a set changes identity whenever any row toggles, which would re-render all of them.
 * A durable line arriving rebuilds the layout, so two more things keep the rows still across it:
 * the layout hands back the previous item for every row the line did not change
 * (`keepUnchanged.ts`), and the paired results come apart from `rowContext` so a row compares only
 * the results for its own calls (`sameRow` below). A new result re-renders the call it answers.
 */
type RowItem = FeedItem | { kind: "tail"; ev: ActivityEvent } | undefined;

type ActivityFeedRowProps = {
  expandCluster: (leadIndex: number) => void;
  /** On a gap row: its last page failed to load, so it offers to try again. */
  gapFailed: boolean;
  /** The virtual row's position in the list, which the virtualizer reads back when it measures. */
  index: number;
  isCollapsed: boolean;
  isHighlighted: boolean;
  it: RowItem;
  measureElement: (node: Element | null) => void;
  /** Every paired result in the thread. A row re-renders only when one of ITS calls' changes. */
  pairedToolResults: ReadonlyMap<string, PairedToolResult>;
  retryGap: (gap: GapItem) => void;
  rowContext: Omit<EventRowContext, "pairedToolResults">;
  start: number;
  toggleEvent: (eventIdx: number) => void;
  toggleLiveTail: (key: string) => void;
};

/** The calls a row draws, which are the only entries of `pairedToolResults` it reads. */
function rowCallIds(it: RowItem): string[] {
  if (!it) return [];
  const events = it.kind === "tail" ? [it.ev] : itemEvents(it);
  return events.flatMap((event) =>
    event.blocks.flatMap((block) => (block.kind === "tool_use" && block.callId ? [block.callId] : [])),
  );
}

function sameRow(previous: ActivityFeedRowProps, next: ActivityFeedRowProps): boolean {
  for (const key of Object.keys(next) as (keyof ActivityFeedRowProps)[]) {
    if (key === "pairedToolResults") continue;
    if (!Object.is(previous[key], next[key])) return false;
  }
  if (previous.pairedToolResults === next.pairedToolResults) return true;
  return rowCallIds(next.it).every(
    (callId) => previous.pairedToolResults.get(callId) === next.pairedToolResults.get(callId),
  );
}

export const ActivityFeedRow = memo(function ActivityFeedRow({
  expandCluster,
  gapFailed,
  index,
  isCollapsed,
  isHighlighted,
  it,
  measureElement,
  pairedToolResults,
  retryGap,
  rowContext: sharedContext,
  start,
  toggleEvent,
  toggleLiveTail,
}: ActivityFeedRowProps) {
  const rowContext: EventRowContext = useMemo(
    () => ({ ...sharedContext, pairedToolResults }),
    [sharedContext, pairedToolResults],
  );
  if (!it) return null;
  return (
    <div
      ref={measureElement}
      data-index={index}
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        transform: `translateY(${start}px)`,
        // A row that is too wide scrolls INSIDE its own band, and the column never moves.
        //
        // The feed's scroller is `overflow-y-auto`, and CSS computes the other axis of that to
        // `auto` as well, so the transcript has always had a horizontal scrollbar nobody asked
        // for. One overflowing descendant anywhere in a virtualised list of several thousand rows
        // was enough to use it: these bands are `width: 100%` of the container and do not grow
        // with its scroll width, so every ordinary row slid left and clipped against the edge
        // while the row that actually caused it sat off screen. Reported as a wrapping bug on the
        // compaction row, which was innocent -- that record is twenty characters long, and the
        // bar naming it is the STICKY header, which names the last user row above wherever you
        // are rather than the row that overflowed.
        //
        // Here rather than on the scroller, where `overflow-x: hidden` is one line: that would
        // clip whatever is wide with no way to reach it, and it is still unidentified. A band
        // that scrolls puts the scrollbar on the row that earned it and keeps its content
        // reachable.
        overflowX: "auto",
      }}
    >
      {it.kind === "gap" ? (
        <GapRow failed={gapFailed} onRetry={() => retryGap(it)} />
      ) : it.kind === "tail" ? (
        <LiveTailRow
          ev={it.ev}
          ctx={rowContext}
          // Its own state, not a member of `collapsed`: the index this
          // event carries counts rows in the sidecar's live projection,
          // not lines in the transcript, so it is not a key those share.
          // The durable row that takes the message over arrives under its
          // own transcript index, expanded.
          isCollapsed={isCollapsed}
          onToggle={() => toggleLiveTail(liveRowKey(it.ev))}
        />
      ) : it.kind === "cluster" ? (
        <ClusterRow
          events={it.events}
          // A folded run is a self-contained band, so it takes both
          // rounded ends rather than joining the segment's border run:
          // the rows it stands for are not on screen to join to.
          isFirst
          isLast
          onExpand={() => expandCluster(it.events[0]!.index)}
        />
      ) : it.kind === "user" ? (
        <UserRow
          ev={it.ev}
          ctx={rowContext}
          isCollapsed={isCollapsed}
          onToggle={() => toggleEvent(it.ev.index)}
          isHighlighted={isHighlighted}
        />
      ) : it.kind === "compaction" ? (
        <CompactionRow ev={it.ev} ctx={rowContext} />
      ) : (
        <SegmentEventRow
          ev={it.ev}
          ctx={rowContext}
          isFirst={it.isFirst}
          isLast={it.isLast}
          isCollapsed={isCollapsed}
          onToggle={() => toggleEvent(it.ev.index)}
          isHighlighted={isHighlighted}
        />
      )}
    </div>
  );
}, sameRow);
