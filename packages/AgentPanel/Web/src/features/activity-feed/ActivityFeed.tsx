"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, ChevronRight, FoldVertical, UnfoldVertical } from "lucide-react";
import {
  liveRowKey,
  useSessionEventsStream,
  type ActivityEvent,
  type TokenUsage,
} from "@/features/activity-feed/useSessionEventsStream";
import { useStickToBottom } from "@/features/activity-feed/scroll-position/useStickToBottom";
import {
  type DisplayItem,
  type DisplayRole,
  displayRole,
  itemKey,
  leadEvent,
} from "@/features/activity-feed/rows/activityDisplayItems";
import { eventPreview } from "@/features/activity-feed/rows/activityEventText";
import { buildFeedLayout } from "@/features/activity-feed/rows/activityFeedLayout";
import {
  jumpScrollTop,
  selectStickyCurrentIndex,
  selectStickyUserIndex,
} from "@/features/activity-feed/sticky-headers/activityStickyHeaders";
import {
  forgetTranscriptAnchor,
  loadTranscriptAnchor,
  rememberTranscriptAnchor,
} from "@/features/activity-feed/scroll-position/transcriptScrollStore";
import {
  ClusterRow,
  CompactionRow,
  LiveTailRow,
  ROLE_BORDER,
  ROLE_STYLES,
  SegmentEventRow,
  showEventRoleLabel,
  UserRow,
  type EventRowContext,
} from "@/features/activity-feed/blocks/ActivityEventRows";
import type { AgentSource, EventMode } from "@/features/activity-feed/data-source/AgentDataSource";
import type { AgentSessionControlState } from "@/features/activity-feed/data-source/AgentDataSource";
import { openAskUserQuestion, type OpenAskUserQuestion } from "@/app/askUserQuestion";

import { ActivityFeedControls } from "@/features/activity-feed/ActivityFeedControls";
import { StickyEventHeader, StickyUserHeader } from "@/features/activity-feed/sticky-headers/ActivityFeedStickyHeaders";
import { ActivityFeedRow } from "@/features/activity-feed/ActivityFeedRow";
import { useFeedRows } from "@/features/activity-feed/rows/useFeedRows";
import { useStickyIndices } from "@/features/activity-feed/sticky-headers/useStickyIndices";
import { useTranscriptScrollRestore } from "@/features/activity-feed/scroll-position/useTranscriptScrollRestore";

export function ActivityFeed({
  source,
  sessionId,
  mode,
  onToggleMode,
  canToggleMode = true,
  showCacheHits,
  onToggleCacheHits,
  controlsHost,
  onSessionState,
  onUsage,
  onOpenQuestion,
  onForkFromMessage,
}: {
  source: AgentSource;
  sessionId: string;
  /**
   * Which view to render. Owned by the shell rather than here so the choice
   * survives switching threads, and so this component remounts when it changes --
   * every index it holds is counted in the mode, so none of them survives a
   * switch.
   */
  mode: EventMode;
  onToggleMode: () => void;
  canToggleMode?: boolean;
  /**
   * Whether per-turn prompt-cache badges render next to the rows that carry
   * cache data. Pure presentation: the data already rides the events, so toggling
   * never refetches anything.
   */
  showCacheHits: boolean;
  onToggleCacheHits: () => void;
  /**
   * Where to render the thread's controls, supplied by the shell so the thread
   * spends no row of its own on them. `null` only while the shell's header is
   * still mounting; required rather than optional so a shell cannot drop the
   * controls by forgetting to pass it.
   */
  controlsHost: HTMLElement | null;
  onSessionState?: (state: AgentSessionControlState) => void;
  /**
   * Mirrors the session's latest context-window occupancy up to the shell. The
   * composer band renders it, so it lives here rather than in the header; the
   * feed owns the stream that carries it. `null` while nothing has arrived.
   */
  onUsage?: (usage: TokenUsage | null) => void;
  /**
   * Mirrors the session's open AskUserQuestion up to the shell. The composer band
   * renders the mirror, so it lives here rather than in the header; the feed owns
   * the event stream the question is derived from. `null` while no question is open.
   */
  onOpenQuestion?: (question: OpenAskUserQuestion | null) => void;
  /**
   * Branches this session from one of its messages, or absent where that cannot be offered.
   *
   * Passed straight through to the rows rather than acted on here: the feed renders a transcript
   * and owns no session commands, and the surface that mounts it is the one with somewhere to put
   * a fork.
   */
  onForkFromMessage?: (message: { eventId: string; text: string }) => void;
}) {
  const { events, loadOlder, windowStart, usage, loading, error, runState, queue, liveTails } =
    useSessionEventsStream(source, sessionId, mode);
  useEffect(() => {
    onSessionState?.({ runState, queue });
  }, [onSessionState, queue.followUp, queue.steer, runState]);
  useEffect(() => {
    onUsage?.(usage);
  }, [onUsage, usage]);
  // The open AskUserQuestion derives from the stream the feed owns. Memoized so
  // the shell's mirror only re-renders when the answer actually changes it.
  const openQuestion = useMemo(
    () => openAskUserQuestion(events, liveTails),
    [events, liveTails],
  );
  useEffect(() => {
    onOpenQuestion?.(openQuestion);
  }, [onOpenQuestion, openQuestion]);
  const parentRef = useRef<HTMLDivElement>(null);
  const sizedRef = useRef<HTMLDivElement>(null);
  const stickyHeaderRef = useRef<HTMLButtonElement>(null);
  // Anchor for scroll-up paging: when loadOlder prepends a page, totalSize
  // grows by the new rows' height. Capturing scrollHeight before the fetch
  // lets us add the delta to scrollTop after the layout settles, so the row
  // the user was looking at stays put instead of jumping downward.
  const pendingAnchorRef = useRef<number | null>(null);
  const prevWindowStartRef = useRef<number>(0);

  // Follow-the-tail: stick to the bottom as the thread grows, release when the
  // user scrolls up. The hook owns a ResizeObserver on the measured content and
  // reads intent off the input that caused a scroll, so nothing here depends on
  // estimated row heights or a from-bottom threshold. `pause()` detaches on
  // user-driven restructures (collapse/expand, jump-to-message).
  const { following, onScroll, scrollToBottom, pause } = useStickToBottom(
    parentRef,
    sizedRef,
    // Follow the bottom when there is durable content OR a streaming live tail
    // to pin to. A fresh session that only has the live mirror would otherwise
    // never arm the follower, so its growing tail wouldn't auto-scroll.
    events.length > 0 || liveTails.length > 0,
  );

  // Scroll offset the sticky bars are computed from.
  //
  // This has to be state, not a read of `scrollTop` inside a memo keyed on the
  // virtualizer's visible range. That range only changes identity when the
  // window of rendered rows changes, so on a thread short enough to fit inside
  // the overscan it never changes at all -- and the bars, computed once at
  // mount, then never updated again for the life of the thread.
  const [scrollTop, setScrollTop] = useState(0);
  const handleScroll = useCallback(() => {
    onScroll();
    const el = parentRef.current;
    if (el) setScrollTop(el.scrollTop);
  }, [onScroll]);
  const {
    allCollapsed,
    allEventIds,
    collapse: collapseAll,
    collapsed,
    expandAll,
    expandCluster,
    expandedTools,
    flashHighlight,
    highlightedEvIdx,
    collapsedTails,
    items,
    pairedToolResults,
    rowItems,
    toggleEvent,
    toggleLiveTail,
    toggleTool,
  } = useFeedRows({ events, liveTails, mode, pause, source });


  const rowContext: EventRowContext = useMemo(
    () => ({
      session: { source, sessionId, mode },
      // These events ARE this session's transcript, so an index names a line it can fetch back.
      rawSource: "addressable",
      expandedTools,
      onToggleTool: toggleTool,
      pairedToolResults,
      showCacheHits,
      ...(onForkFromMessage === undefined ? {} : { onForkFromMessage }),
    }),
    [
      source,
      sessionId,
      mode,
      expandedTools,
      toggleTool,
      pairedToolResults,
      showCacheHits,
      onForkFromMessage,
    ],
  );

  const rowVirtualizer = useVirtualizer({
    count: rowItems.length,
    getScrollElement: () => parentRef.current,
    // Rough, and only used before a row has been measured: a collapsed row is
    // now one line beside its chip, an expanded one a short block.
    estimateSize: (i) => {
      const it = rowItems[i];
      if (!it) return 88;
      if (it.kind === "tail") return collapsedTails.has(liveRowKey(it.ev)) ? 32 : 88;
      // A folded cluster is always one line, whatever it holds.
      if (it.kind === "cluster") return 32;
      if (collapsed.has(it.ev.index)) return 32;
      return 88;
    },
    overscan: 8,
    // Key by event identity (not index) so that when loadOlder prepends a
    // page and every existing event's array index shifts, the virtualizer
    // keeps its cached measurements. Without this, scrolling up after a
    // prepend causes a wave of re-measurements that flickers visible text.
    // virtual-core's default scroll-anchoring on size-change does the rest.
    getItemKey: (i) => {
      const it = rowItems[i];
      if (!it) return i;
      if (it.kind === "tail") return `live-tail:${liveRowKey(it.ev)}`;
      return itemKey(it);
    },
  });

  const virtualItems = rowVirtualizer.getVirtualItems();
  const totalSize = rowVirtualizer.getTotalSize();

  const {
    stickyCurrent,
    stickyCurrentIndex,
    stickyUser,
    stickyUserIndex,
    topEvent,
  } = useStickyIndices({
    items,
    mode,
    rowItems,
    rowVirtualizer,
    scrollTop,
    stickyHeaderRef,
    virtualItems,
  });

  useTranscriptScrollRestore({
    following,
    parentRef,
    pause,
    rowItems,
    rowVirtualizer,
    sessionId,
    source,
    topEvent,
    virtualItems,
  });


  // One synchronous scroll write per jump. The earlier two-step (jump to the
  // row top, then rAF-correct for the bar) showed the row under the bar before
  // it slid into place.
  const jumpTo = useCallback(
    (rowIndex: number, reservedHeight: number) => {
      const el = parentRef.current;
      const measurement = rowVirtualizer.measurementsCache[rowIndex];
      const item = items[rowIndex];
      if (!el || !measurement || !item) return;
      pause();
      el.scrollTop = jumpScrollTop(measurement, reservedHeight);
      flashHighlight(leadEvent(item).index);
    },
    [items, rowVirtualizer, flashHighlight, pause],
  );

  useEffect(() => {
    if (virtualItems.length === 0) return;
    const first = virtualItems[0];
    if (first && first.index < 20 && windowStart > 0 && pendingAnchorRef.current === null) {
      const el = parentRef.current;
      pendingAnchorRef.current = el ? el.scrollHeight : 0;
      void loadOlder();
    }
  }, [virtualItems, windowStart, loadOlder]);

  // After older events are prepended, totalSize jumps. Add the delta to
  // scrollTop in the same layout pass so the visible rows do not shift.
  useLayoutEffect(() => {
    if (windowStart < prevWindowStartRef.current && pendingAnchorRef.current !== null) {
      const el = parentRef.current;
      if (el) {
        const delta = el.scrollHeight - pendingAnchorRef.current;
        if (delta > 0) el.scrollTop += delta;
      }
      pendingAnchorRef.current = null;
    }
    prevWindowStartRef.current = windowStart;
  }, [windowStart, totalSize]);

  const threadControls = (
    <ActivityFeedControls
      allCollapsed={allCollapsed}
      allEventIds={allEventIds}
      canToggleMode={canToggleMode}
      collapseAll={collapseAll}
      controlsHost={controlsHost}
      expandAll={expandAll}
      mode={mode}
      onToggleMode={onToggleMode}
      showCacheHits={showCacheHits}
      onToggleCacheHits={onToggleCacheHits}
    />
  );


  if (loading && events.length === 0 && liveTails.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-(length:--agent-panel-fs-canvas-menu,13px) text-muted-foreground">
        loading session events…
      </div>
    );
  }
  if (error && events.length === 0 && liveTails.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-(length:--agent-panel-fs-canvas-menu,13px) text-destructive">
        {error}
      </div>
    );
  }
  if (rowItems.length === 0) {
    const hasHiddenSystemEvents = mode === "nice" && events.length > 0;
    return (
      <>
        {hasHiddenSystemEvents ? threadControls : null}
        <div className="flex h-full items-center justify-center text-(length:--agent-panel-fs-canvas-menu,13px) text-muted-foreground">
          {hasHiddenSystemEvents ? "no content events" : "no events"}
        </div>
      </>
    );
  }

  return (
    <div className="relative h-full overflow-hidden">
      {threadControls}
      <div
        ref={parentRef}
        onScroll={handleScroll}
        className="h-full overflow-y-auto"
        style={{ overflowAnchor: "none" }}
      >
        <div
          ref={sizedRef}
          style={{
            height: rowVirtualizer.getTotalSize(),
            position: "relative",
            width: "100%",
          }}
        >
          {virtualItems.map((virtualRow) => {
            const it = rowItems[virtualRow.index];
            return (
              <ActivityFeedRow
                key={it?.kind === "tail"
                  ? `live-tail:${liveRowKey(it.ev)}`
                  : it ? itemKey(it) : virtualRow.index}
                collapsed={collapsed}
                expandCluster={expandCluster}
                highlightedEvIdx={highlightedEvIdx}
                it={it}
                collapsedTails={collapsedTails}
                rowContext={rowContext}
                rowVirtualizer={rowVirtualizer}
                toggleEvent={toggleEvent}
                toggleLiveTail={toggleLiveTail}
                virtualRow={virtualRow}
              />
            );
          })}
        </div>
      </div>
      {(stickyUser || stickyCurrent) ? (
        <div className="absolute inset-x-0 top-0 z-20 flex flex-col">
          {stickyUser && stickyUserIndex !== null ? (
            <StickyUserHeader
              ev={stickyUser}
              buttonRef={stickyHeaderRef}
              // Jumping to a user row disengages its own bar, so no space is
              // reserved: the row lands flush with the top of the viewport.
              onClick={() => jumpTo(stickyUserIndex, 0)}
            />
          ) : null}
          {stickyCurrent && stickyCurrentIndex !== null ? (
            <StickyEventHeader
              item={stickyCurrent}
              mode={mode}
              // The user bar stays up when jumping to a row below it, so that
              // height has to stay clear.
              onClick={() =>
                jumpTo(
                  stickyCurrentIndex,
                  stickyUser ? (stickyHeaderRef.current?.offsetHeight ?? 0) : 0,
                )
              }
            />
          ) : null}
        </div>
      ) : null}
      {!following ? (
        <button
          type="button"
          onClick={scrollToBottom}
          title="Jump to live tail"
          aria-label="scroll to bottom"
          className="absolute bottom-3 right-3 z-30 flex items-center gap-1.5 rounded-full border border-border bg-card/95 px-3 py-1.5 font-mono text-foreground/80 shadow-md backdrop-blur transition-colors hover:bg-muted hover:text-foreground"
          style={{ fontSize: "var(--agent-panel-fs-tile-chip, 12px)" }}
        >
          <ArrowDown className="size-[1.1em]" aria-hidden />
          <span>Scroll down</span>
        </button>
      ) : null}
    </div>
  );
}
