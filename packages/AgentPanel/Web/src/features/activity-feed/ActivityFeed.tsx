"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, ChevronRight, FoldVertical, UnfoldVertical } from "lucide-react";
import {
  useSessionEventsStream,
  type ActivityEvent,
  type TokenUsage,
} from "@/features/activity-feed/useSessionEventsStream";
import { liveRowKey } from "@/features/activity-feed/rows/liveTailBlocks";
import { CompactingNotice } from "@/features/activity-feed/blocks/CompactingNotice";
import { useStickToBottom } from "@/features/activity-feed/scroll-position/useStickToBottom";
import {
  type DisplayItem,
  type DisplayRole,
  displayRole,
  isEventItem,
  itemKey,
  leadEvent,
} from "@/features/activity-feed/rows/activityDisplayItems";
import { eventPreview } from "@/features/activity-feed/rows/activityEventText";
import { buildFeedLayout } from "@/features/activity-feed/rows/activityFeedLayout";
import {
  jumpScrollTop,
  selectStickyCurrentIndex,
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
import {
  StickyEventHeader,
  StickyUserHeader,
  userMessageText,
} from "@/features/activity-feed/sticky-headers/ActivityFeedStickyHeaders";
import { useJumpToMessage, useRemoteUserBar } from "@/features/activity-feed/sticky-headers/useRemoteUserBar";
import { ActivityFeedRow } from "@/features/activity-feed/ActivityFeedRow";
import { useFeedRows } from "@/features/activity-feed/rows/useFeedRows";
import { useStickyIndices } from "@/features/activity-feed/sticky-headers/useStickyIndices";
import { useTranscriptScrollRestore } from "@/features/activity-feed/scroll-position/useTranscriptScrollRestore";
import { useOlderPageAnchor } from "@/features/activity-feed/scroll-position/useOlderPageAnchor";
import { gapIdentity, useGapFill } from "@/features/activity-feed/scroll-position/useGapFill";

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
  onSessionModel,
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
   * Mirrors the session's current model up to the shell. The composer band renders it as the
   * switcher label, so it lives here beside usage; the feed owns the stream that carries it.
   * Separate because usage blanks across a post-compaction gap while the model survives it.
   * `null` while nothing has named one.
   */
  onSessionModel?: (model: string | null) => void;
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
  const {
    events, loadOlder, fillGap, loadAround, windowStart, usage, sessionModel, loading, error, runState, queue, snapshotCount, liveTails, compactionSummary,
  } = useSessionEventsStream(source, sessionId, mode);
  useEffect(() => {
    onSessionState?.({ runState, queue });
  }, [onSessionState, queue.followUp, queue.steer, runState]);
  useEffect(() => {
    onUsage?.(usage);
  }, [onUsage, usage]);
  useEffect(() => {
    onSessionModel?.(sessionModel);
  }, [onSessionModel, sessionModel]);
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

  // Scroll offset the sticky bars are computed from, read from a ref at every render. A scroll
  // re-renders only when it moves a bar or the top line (`changesAt`, in `useStickyIndices`), not
  // on the virtualizer's range, which never changes on a thread short enough to fit its overscan.
  const scrollTopRef = useRef(0);
  const [, setStickyScroll] = useState(0);
  const changesAtRef = useRef<(offset: number) => boolean>(() => true);
  const handleScroll = useCallback(() => {
    onScroll();
    const el = parentRef.current;
    if (!el) return;
    scrollTopRef.current = el.scrollTop;
    if (changesAtRef.current(el.scrollTop)) setStickyScroll(el.scrollTop);
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


  // Without the paired results, which go to each row on their own so a new pairing re-renders only
  // the row whose call it answers (`ActivityFeedRow`).
  const rowContext: Omit<EventRowContext, "pairedToolResults"> = useMemo(
    () => ({
      session: { source, sessionId, mode },
      // These events ARE this session's transcript, so an index names a line it can fetch back.
      rawSource: "addressable",
      expandedTools,
      onToggleTool: toggleTool,
      showCacheHits,
      ...(onForkFromMessage === undefined ? {} : { onForkFromMessage }),
    }),
    [
      source,
      sessionId,
      mode,
      expandedTools,
      toggleTool,
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
      // A folded cluster is always one line, whatever it holds, and so is a gap.
      if (it.kind === "cluster" || it.kind === "gap") return 32;
      if (collapsed.has(it.ev.index)) return 32;
      return 88;
    },
    overscan: 8,
    // Keeps the row the reader is on in place when an older page is prepended (see
    // `useOlderPageAnchor`). Following the bottom stays `useStickToBottom`'s job.
    anchorTo: "end",
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

  // The position the bar needs the sidecar for, from the last answer below. Held in state so the
  // answer can size the bars on the render after it arrives; one render behind is what that costs.
  const [askBefore, setAskBefore] = useState<number | null>(null);
  // Claude only: the sidecar's walk back reads a Claude transcript.
  const remoteBar = useRemoteUserBar(sessionId, source === "claude" ? askBefore : null);
  const jumpToMessage = useJumpToMessage({ flashHighlight, items, loadAround, pause, rowVirtualizer });

  const {
    stickyCurrent,
    stickyCurrentIndex,
    stickyUser,
    stickyUserIndex,
    topEvent,
    topRowIndex,
    userBarBefore,
    changesAt,
  } = useStickyIndices({
    items,
    mode,
    oldestStart: source === "claude" ? windowStart : null,
    remote: remoteBar.remote,
    rowItems,
    rowVirtualizer,
    scrollTop: scrollTopRef.current,
    stickyHeaderRef,
    virtualItems,
  });
  changesAtRef.current = changesAt;
  useEffect(() => { setAskBefore(userBarBefore); }, [userBarBefore]);
  const remoteMessage = userBarBefore !== null && remoteBar.remote?.before === userBarBefore ? remoteBar.message : null;

  const { restoring } = useTranscriptScrollRestore({
    following,
    loadAround,
    parentRef,
    pause,
    rowItems,
    rowVirtualizer,
    sessionId,
    source,
    timelineEpoch: snapshotCount,
    topEvent,
    virtualItems,
  });

  // One synchronous scroll write per jump. The earlier two-step (jump to the
  // row top, then rAF-correct for the bar) showed the row under the bar before
  // it slid into place. A flush jump goes through the virtualizer instead, which
  // re-aims until the row holds still: a jump upward counts as a backward scroll,
  // and the virtualizer does not compensate re-measured rows above the fold during
  // one, so a direct write landed the row 47px short (measured 2026-10-05).
  const jumpTo = useCallback(
    (rowIndex: number, reservedHeight: number) => {
      const el = parentRef.current;
      const measurement = rowVirtualizer.measurementsCache[rowIndex];
      const item = items[rowIndex];
      if (!el || !measurement || !item || !isEventItem(item)) return;
      pause();
      if (reservedHeight === 0) rowVirtualizer.scrollToIndex(rowIndex, { align: "start" });
      else el.scrollTop = jumpScrollTop(measurement, reservedHeight);
      flashHighlight(leadEvent(item).index);
    },
    [items, rowVirtualizer, flashHighlight, pause],
  );

  useOlderPageAnchor({ loadOlder, virtualItems, windowStart });
  const { failedGaps, retryGap } = useGapFill({ fillGap, rowItems, topRowIndex, virtualItems });

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
    <div className="relative h-full overflow-hidden" aria-busy={restoring}>
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
            // The virtualiser still measures these rows while an older anchor is being
            // paged in. Only their paint is withheld, so the reader does not see the
            // opening window's first row as if it were the saved place.
            opacity: restoring ? 0 : 1,
          }}
        >
          {virtualItems.map((virtualRow) => {
            const it = rowItems[virtualRow.index];
            const own = it !== undefined && it.kind !== "tail" && it.kind !== "cluster" && it.kind !== "gap"
              ? it.ev.index
              : null;
            return (
              <ActivityFeedRow
                key={it?.kind === "tail"
                  ? `live-tail:${liveRowKey(it.ev)}`
                  : it ? itemKey(it) : virtualRow.index}
                expandCluster={expandCluster}
                gapFailed={it?.kind === "gap" && failedGaps.has(gapIdentity(it))}
                index={virtualRow.index}
                isCollapsed={it?.kind === "tail" ? collapsedTails.has(liveRowKey(it.ev)) : own !== null && collapsed.has(own)}
                isHighlighted={own !== null && highlightedEvIdx === own}
                it={it}
                measureElement={rowVirtualizer.measureElement}
                pairedToolResults={pairedToolResults}
                retryGap={retryGap}
                rowContext={rowContext}
                start={virtualRow.start}
                toggleEvent={toggleEvent}
                toggleLiveTail={toggleLiveTail}
              />
            );
          })}
        </div>
      </div>
      {restoring ? (
        <div
          className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center bg-background/70"
          role="status"
          aria-live="polite"
        >
          <span
            className="rounded-sm border border-border bg-card/95 px-3 py-1.5 font-mono text-foreground/80 shadow-sm"
            style={{ fontSize: "var(--agent-panel-fs-tile-chip, 12px)" }}
          >
            restoring your place…
          </span>
        </div>
      ) : null}
      {(stickyUser || remoteMessage || stickyCurrent) ? (
        <div className="absolute inset-x-0 top-0 z-20 flex flex-col">
          {stickyUser && stickyUserIndex !== null ? (
            <StickyUserHeader
              text={userMessageText(stickyUser)}
              buttonRef={stickyHeaderRef}
              // Jumping to a user row disengages its own bar, so no space is
              // reserved: the row lands flush with the top of the viewport.
              onClick={() => jumpTo(stickyUserIndex, 0)}
            />
          ) : remoteMessage ? (
            <StickyUserHeader
              text={remoteMessage.text}
              buttonRef={stickyHeaderRef}
              // Not held, so this reads the rows around the message and lands on it.
              onClick={() => jumpToMessage(remoteMessage)}
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
                  stickyUser || remoteMessage ? (stickyHeaderRef.current?.offsetHeight ?? 0) : 0,
                )
              }
            />
          ) : null}
        </div>
      ) : null}
      {compactionSummary !== null ? <CompactingNotice summary={compactionSummary} /> : null}
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
