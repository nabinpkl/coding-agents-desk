"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, ChevronRight, FoldVertical, UnfoldVertical } from "lucide-react";
import {
  useSessionEventsStream,
  type ActivityEvent,
  type TokenUsage,
} from "./useSessionEventsStream";
import { useStickToBottom } from "./useStickToBottom";
import {
  buildFeedLayout,
  displayRole,
  eventPreview,
  itemKey,
  leadEvent,
  type DisplayItem,
  type DisplayRole,
} from "./activityDisplayItems";
import {
  jumpScrollTop,
  selectStickyCurrentIndex,
  selectStickyUserIndex,
} from "./activityStickyHeaders";
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
} from "./ActivityEventRows";
import type { AgentSource, EventMode } from "./data-source/AgentDataSource";
import type { AgentSessionControlState } from "./data-source/AgentDataSource";
import { openAskUserQuestion, type OpenAskUserQuestion } from "../../app/askUserQuestion";

/** Fallback for the sticky bar's height before it has rendered once. */
const STICKY_HEIGHT_ESTIMATE = 44;

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
}) {
  const { events, loadOlder, windowStart, usage, loading, error, runState, queue, liveTail } =
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
    () => openAskUserQuestion(events, liveTail),
    [events, liveTail],
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
    events.length > 0 || liveTail != null,
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

  // Per-event collapse: each agent/result event has its own toggle. Set
  // contains event indices currently collapsed (heading-only).
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const defaultedSystemEventsRef = useRef<Set<number>>(new Set());

  // System events are transcript scaffolding rather than the agent's working
  // thread, so start each one collapsed. Record which events received the
  // default once so a later live update does not re-collapse a row the user
  // explicitly expanded.
  useLayoutEffect(() => {
    const newSystemEventIds = events
      .filter(
        (event) =>
          event.type === "system" && !defaultedSystemEventsRef.current.has(event.index),
      )
      .map((event) => event.index);
    if (newSystemEventIds.length === 0) return;

    for (const eventId of newSystemEventIds) {
      defaultedSystemEventsRef.current.add(eventId);
    }
    setCollapsed((previous) => new Set([...previous, ...newSystemEventIds]));
  }, [events]);

  // Per-tool-call expansion: tool_use blocks are collapsed by default so the
  // feed reads as a tight call list (e.g. `[Edit] file.tsx`) and the noisy
  // diff / output body only opens on click. Membership = currently expanded.
  // Key is `callId` when available (stable across reorderings), else a
  // composite of event+block indices.
  const [expandedTools, setExpandedTools] = useState<Set<string>>(new Set());
  const toggleTool = useCallback((key: string) => {
    pause();
    setExpandedTools((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }, [pause]);

  // Event index currently flashing after a sticky-jump click. Cleared on a
  // timer so the ring on the landed row fades out without further interaction.
  const [highlightedEvIdx, setHighlightedEvIdx] = useState<number | null>(null);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashHighlight = useCallback((evIdx: number) => {
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    setHighlightedEvIdx(evIdx);
    highlightTimerRef.current = setTimeout(() => {
      setHighlightedEvIdx(null);
      highlightTimerRef.current = null;
    }, 900);
  }, []);
  useEffect(() => () => {
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
  }, []);

  // Membership means EXPANDED, the opposite of `collapsed`, because a cluster's
  // default is folded and a row's default is open. One set cannot carry both
  // defaults without every read having to know which kind of row it is looking at.
  const [expandedClusters, setExpandedClusters] = useState<Set<number>>(new Set());
  const expandCluster = useCallback((leadIndex: number) => {
    pause();
    setExpandedClusters((previous) => new Set(previous).add(leadIndex));
  }, [pause]);

  const { items, allEventIds, clusterLeadIds, pairedToolResults } = useMemo(
    // Clustering and scaffolding removal belong to Nice alone. Raw stays one
    // row per transcript line, which is the fidelity guarantee Nice leans on.
    () => buildFeedLayout(events, {
      cluster: mode === "nice",
      hideSystem: mode === "nice",
      incrementalReasoning: mode === "nice" && source === "codex",
      expandedClusters,
    }),
    [events, mode, source, expandedClusters],
  );

  // The live in-flight message is one extra row appended after the durable
  // layout (the "live tail"). It streams until the durable transcript contains
  // the same `messageId`, at which point the hook clears it and the durable row
  // owns it. Kept separate from `items` so sticky/jump logic never treats it as
  // a real conversation row.
  const rowItems = useMemo(() => {
    const rows: Array<DisplayItem | { kind: "tail"; ev: ActivityEvent }> = [...items];
    if (liveTail) rows.push({ kind: "tail", ev: liveTail });
    return rows;
  }, [items, liveTail]);

  const allCollapsed =
    allEventIds.length > 0 &&
    allEventIds.every((id) => collapsed.has(id)) &&
    expandedClusters.size === 0;

  const toggleEvent = useCallback((eventIdx: number) => {
    pause();
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(eventIdx)) next.delete(eventIdx); else next.add(eventIdx);
      return next;
    });
  }, [pause]);

  // The live tail's own collapse state, deliberately NOT a member of `collapsed`.
  //
  // Those are transcript indices. The tail's index is a position in the sidecar's live
  // projection -- a different space entirely, counted per session from the mirror's
  // first row, where the transcript counts lines. On a live thread the two overlap
  // constantly (a tail at 418 while the transcript is at 2965), so sharing the set made
  // collapsing one unrelated row hundreds of messages back also collapse the message
  // being written. One boolean, because the tail is one row.
  const [liveTailCollapsed, setLiveTailCollapsed] = useState(false);
  const toggleLiveTail = useCallback(() => {
    pause();
    setLiveTailCollapsed((previous) => !previous);
  }, [pause]);

  const collapseAll = useCallback(() => {
    pause();
    setCollapsed(new Set(allEventIds));
    setExpandedClusters(new Set());
  }, [allEventIds, pause]);
  const expandAll = useCallback(() => {
    pause();
    setCollapsed(new Set());
    setExpandedClusters(new Set(clusterLeadIds));
  }, [clusterLeadIds, pause]);

  const rowContext: EventRowContext = useMemo(
    () => ({
      session: { source, sessionId, mode },
      expandedTools,
      onToggleTool: toggleTool,
      pairedToolResults,
      showCacheHits,
    }),
    [source, sessionId, mode, expandedTools, toggleTool, pairedToolResults, showCacheHits],
  );

  const rowVirtualizer = useVirtualizer({
    count: rowItems.length,
    getScrollElement: () => parentRef.current,
    // Rough, and only used before a row has been measured: a collapsed row is
    // now one line beside its chip, an expanded one a short block.
    estimateSize: (i) => {
      const it = rowItems[i];
      if (!it) return 88;
      if (it.kind === "tail") return liveTailCollapsed ? 32 : 88;
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
      if (it.kind === "tail") return `live-tail:${it.ev.messageId ?? i}`;
      return itemKey(it);
    },
  });

  const virtualItems = rowVirtualizer.getVirtualItems();
  const totalSize = rowVirtualizer.getTotalSize();

  // Most recent USER event whose own heading has scrolled out of view.
  // `measurementsCache` is the public mirror of the private getMeasurements();
  // the getVirtualItems() call above refreshes it every render, so it holds
  // current geometry for every row, including those scrolled off. `virtualItems`
  // stays a dependency so a re-measure is picked up even without a scroll.
  const stickyUserIndex = useMemo<number | null>(() => {
    if (items.length === 0) return null;
    return selectStickyUserIndex(
      items,
      rowVirtualizer.measurementsCache,
      scrollTop,
      stickyHeaderRef.current?.offsetHeight ?? STICKY_HEIGHT_ESTIMATE,
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollTop, virtualItems, items]);
  // Only ever a user row, which is always a single event, but resolved through the
  // shared accessor so this does not have to be revisited if another multi-event row
  // kind appears.
  const stickyUserItem = stickyUserIndex === null ? null : items[stickyUserIndex];
  const stickyUser: ActivityEvent | null = stickyUserItem
    ? leadEvent(stickyUserItem)
    : null;

  // Event row currently straddling the top of the viewport: its heading has
  // scrolled past, but its content is still on screen. Drives the secondary
  // sticky which lets the viewer jump back to that row's start.
  const stickyCurrentIndex = useMemo<number | null>(() => {
    if (items.length === 0) return null;
    return selectStickyCurrentIndex(
      items,
      rowVirtualizer.measurementsCache,
      scrollTop,
      stickyUser ? (stickyHeaderRef.current?.offsetHeight ?? STICKY_HEIGHT_ESTIMATE) : 0,
      stickyUserIndex,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollTop, virtualItems, items, stickyUser, stickyUserIndex]);
  const stickyCurrent: DisplayItem | null =
    stickyCurrentIndex === null ? null : items[stickyCurrentIndex] ?? null;

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

  // The thread's controls all live in the shell header, so the transcript spends
  // no band of its own on them. One portal, not one per control: they share a
  // row and their order is a layout decision, which belongs in one place.
  const threadControls = controlsHost
    ? createPortal(
        <>
          {/* The nice view omits harness machinery, so the raw view has to stay one
              press away: it is the fidelity guarantee that makes omitting allowed at
              all, and a viewer who wants to know what was dropped here needs it. */}
          {canToggleMode ? <button
            type="button"
            onClick={onToggleMode}
            title={
              mode === "nice"
                ? "Showing content only. Switch to every transcript line"
                : "Showing every transcript line. Switch to content only"
            }
            aria-label={mode === "nice" ? "show every line" : "show content only"}
            aria-pressed={mode === "raw"}
            className={
              "flex h-8 items-center justify-center rounded-lg px-1.5 font-mono text-(length:--agent-panel-fs-tile-chip,12px) uppercase tracking-wider transition-colors " +
              (mode === "raw"
                ? "bg-primary/20 text-primary hover:bg-primary/30"
                : "text-muted-foreground hover:bg-muted hover:text-foreground active:bg-muted/80")
            }
          >
            {mode === "raw" ? "raw" : "nice"}
          </button> : null}
          <button
            type="button"
            onClick={onToggleCacheHits}
            title={
              showCacheHits
                ? "Hiding per-turn prompt-cache badges"
                : "Show how much of each turn's prompt was served from the prompt cache"
            }
            aria-label={showCacheHits ? "hide prompt cache badges" : "show prompt cache badges"}
            aria-pressed={showCacheHits}
            className={
              "flex h-8 items-center justify-center rounded-lg px-1.5 font-mono text-(length:--agent-panel-fs-tile-chip,12px) uppercase tracking-wider transition-colors " +
              (showCacheHits
                ? "bg-emerald-500/20 text-emerald-600 hover:bg-emerald-500/30 dark:text-emerald-400"
                : "text-muted-foreground hover:bg-muted hover:text-foreground active:bg-muted/80")
            }
          >
            cache
          </button>
          <button
            type="button"
            onClick={allCollapsed ? expandAll : collapseAll}
            disabled={allEventIds.length === 0}
            title={allCollapsed ? "Expand all agent sections" : "Collapse all agent sections"}
            aria-label={allCollapsed ? "expand all" : "collapse all"}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground active:bg-muted/80 disabled:opacity-40"
          >
            {allCollapsed ? (
              <UnfoldVertical className="h-4 w-4" aria-hidden />
            ) : (
              <FoldVertical className="h-4 w-4" aria-hidden />
            )}
          </button>
        </>,
        controlsHost,
      )
    : null;

  if (loading && events.length === 0 && !liveTail) {
    return (
      <div className="flex h-full items-center justify-center text-(length:--agent-panel-fs-canvas-menu,13px) text-muted-foreground">
        loading session events…
      </div>
    );
  }
  if (error && events.length === 0 && !liveTail) {
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
            if (!it) return null;
            return (
              <div
                key={it.kind === "tail" ? `live-tail:${it.ev.messageId ?? virtualRow.index}` : itemKey(it)}
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

// Compact pinned header for the most recent USER event the viewer scrolled
// past. Full-width opaque strip flush with the top of the scroll area, so
// rows scroll cleanly under it without the canvas pattern bleeding through.
// Click to jump back to the original message (and break sticky-bottom so the
// jump actually holds instead of snapping to the live tail).
function StickyUserHeader({
  ev, onClick, buttonRef,
}: {
  ev: ActivityEvent;
  onClick: () => void;
  buttonRef: React.RefObject<HTMLButtonElement | null>;
}) {
  // Deliberately not `eventPreview`: this bar stands for a person's message, so
  // it reaches past any leading tool_result for the prose they actually typed.
  // `eventPreview` takes whichever content block comes first, which is right for
  // an agent row and wrong here.
  const text = ev.blocks.find((b) => b.kind === "text")?.text ?? "";
  const preview = text.split("\n")[0]!.trim().slice(0, 200);
  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={onClick}
      title="jump to message"
      className="flex w-full items-center gap-2 border-b border-primary/40 bg-card px-3 py-2 text-left shadow-sm transition-colors hover:bg-muted"
      style={{ fontSize: "var(--agent-panel-fs-tile-other-text, 16px)" }}
    >
      <span className="shrink-0 rounded-md bg-primary/30 px-1.5 py-0.5 font-mono text-(length:--agent-panel-fs-tile-chip,12px) font-semibold uppercase tracking-wider text-primary">
        user #{ev.index}
      </span>
      <span className="min-w-0 flex-1 truncate leading-snug text-foreground">
        {preview || "(no text)"}
      </span>
    </button>
  );
}

// Secondary sticky for the event row currently being scrolled through. Sits
// directly below the primary user sticky and reflects the most recent row
// whose heading has scrolled behind the bar while its content is still on
// screen. Click jumps to that row's start.
function StickyEventHeader({
  item, mode, onClick,
}: {
  item: DisplayItem;
  mode: EventMode;
  onClick: () => void;
}) {
  const ev = leadEvent(item);
  // A folded run is tool work by construction, so it names itself `tool` rather than
  // taking the role of whichever of its members happens to be first.
  const role: DisplayRole =
    item.kind === "user" ? "user" : item.kind === "cluster" ? "tool" : displayRole(ev);
  return (
    <button
      type="button"
      onClick={onClick}
      title="jump to event start"
      className={
        "flex w-full items-center gap-[0.4em] border-b border-l-[3px] border-border bg-card/95 px-3 py-1.5 text-left shadow-sm backdrop-blur transition-colors hover:bg-muted " +
        ROLE_BORDER[role]
      }
      style={{ fontSize: "var(--agent-panel-fs-tile-other-text, 16px)" }}
    >
      <ChevronRight
        className="size-[1.1em] shrink-0 rotate-90 text-muted-foreground"
        aria-hidden
      />
      {showEventRoleLabel(mode, role) ? (
        <span
          className={
            "shrink-0 rounded-sm px-[0.4em] py-[0.1em] font-mono text-(length:--agent-panel-fs-tile-chip,12px) font-bold uppercase tracking-wider " +
            ROLE_STYLES[role]
          }
        >
          {role}
        </span>
      ) : null}
      <span className="min-w-0 flex-1 truncate text-muted-foreground">
        {eventPreview(ev)}
      </span>
    </button>
  );
}
