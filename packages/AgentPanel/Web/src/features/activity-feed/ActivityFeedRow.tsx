"use client";

// One virtualised row of the transcript, whichever kind of row it turns out to be.
//
// The positioning wrapper is here too, because the absolute placement and the measuring
// ref are what make it a virtualised row rather than a row.

import type { Virtualizer, VirtualItem } from "@tanstack/react-virtual";
import type { ActivityEvent } from "@/features/activity-feed/useSessionEventsStream";
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
  liveTailCollapsed,
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
  liveTailCollapsed: boolean;
  rowContext: EventRowContext;
  rowVirtualizer: Virtualizer<HTMLDivElement, Element>;
  toggleEvent: (eventIdx: number) => void;
  toggleLiveTail: () => void;
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
          isCollapsed={liveTailCollapsed}
          onToggle={toggleLiveTail}
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
