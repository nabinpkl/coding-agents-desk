"use client";

// One virtualised row of the transcript, whichever kind of row it turns out to be.
//
// The positioning wrapper is here too, because the absolute placement and the measuring
// ref are what make it a virtualised row rather than a row.

import type { Virtualizer, VirtualItem } from "@tanstack/react-virtual";
import { liveRowKey, type ActivityEvent } from "@/features/activity-feed/useSessionEventsStream";
import type { DisplayItem } from "@/features/activity-feed/rows/activityDisplayItems";
import {
  ClusterRow,
  CompactionRow,
  LiveTailRow,
  SegmentEventRow,
  UserRow,
  type EventRowContext,
} from "@/features/activity-feed/blocks/ActivityEventRows";

export function ActivityFeedRow({
  collapsed,
  expandCluster,
  highlightedEvIdx,
  it,
  collapsedTails,
  rowContext,
  rowVirtualizer,
  toggleEvent,
  toggleLiveTail,
  virtualRow,
}: {
  collapsed: Set<number>;
  expandCluster: (leadIndex: number) => void;
  highlightedEvIdx: number | null;
  it: DisplayItem | { kind: "tail"; ev: ActivityEvent } | undefined;
  collapsedTails: ReadonlySet<string>;
  rowContext: EventRowContext;
  rowVirtualizer: Virtualizer<HTMLDivElement, Element>;
  toggleEvent: (eventIdx: number) => void;
  toggleLiveTail: (key: string) => void;
  virtualRow: VirtualItem;
}) {
  if (!it) return null;
  return (
    <div
      ref={rowVirtualizer.measureElement}
      data-index={virtualRow.index}
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        transform: `translateY(${virtualRow.start}px)`,
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
      {it.kind === "tail" ? (
        <LiveTailRow
          ev={it.ev}
          ctx={rowContext}
          // Its own state, not a member of `collapsed`: the index this
          // event carries counts rows in the sidecar's live projection,
          // not lines in the transcript, so it is not a key those share.
          // The durable row that takes the message over arrives under its
          // own transcript index, expanded.
          isCollapsed={collapsedTails.has(liveRowKey(it.ev))}
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
          isCollapsed={collapsed.has(it.ev.index)}
          onToggle={() => toggleEvent(it.ev.index)}
          isHighlighted={highlightedEvIdx === it.ev.index}
        />
      ) : it.kind === "compaction" ? (
        <CompactionRow ev={it.ev} ctx={rowContext} />
      ) : (
        <SegmentEventRow
          ev={it.ev}
          ctx={rowContext}
          isFirst={it.isFirst}
          isLast={it.isLast}
          isCollapsed={collapsed.has(it.ev.index)}
          onToggle={() => toggleEvent(it.ev.index)}
          isHighlighted={highlightedEvIdx === it.ev.index}
        />
      )}
    </div>
  );
}
