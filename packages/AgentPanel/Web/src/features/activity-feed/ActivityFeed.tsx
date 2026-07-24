"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, ChevronRight, FoldVertical, UnfoldVertical } from "lucide-react";
import {
  useSessionEventsStream,
  type ActivityBlock,
  type ActivityEvent,
} from "./useSessionEventsStream";
import { DiffBlock } from "./DiffBlock";
import { Markdown } from "./markdown/Markdown";
import { useDataSource } from "./data-source/AgentDataSourceContext";
import { useStickToBottom } from "./useStickToBottom";
import {
  buildActivityDisplayItems,
  displayRole,
  type DisplayItem,
  type DisplayRole,
} from "./activityDisplayItems";
import { LabeledTextBlock, RawJsonBlock } from "./ActivitySystemBlocks";
import type { AgentSource } from "./data-source/AgentDataSource";

interface PairedToolResult {
  block: ActivityBlock;
  eventIndex: number;
  blockIndex: number;
  includesRawEvent: boolean;
}

export function ActivityFeed({
  source,
  sessionId,
}: {
  source: AgentSource;
  sessionId: string;
}) {
  const { events, loadOlder, windowStart, loading, error } =
    useSessionEventsStream(source, sessionId);
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
  // attributes scrolls by direction, so nothing here depends on estimated row
  // heights or a from-bottom threshold. `pause()` detaches on user-driven
  // restructures (collapse/expand, jump-to-message).
  const { following, onScroll, scrollToBottom, pause } = useStickToBottom(
    parentRef,
    sizedRef,
    events.length > 0,
  );

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


  // Pair result-only events with their matching tool calls. Mixed events stay
  // independent so user prose or unmatched results are never hidden.
  const { items, allEventIds, pairedToolResults } = useMemo(() => {
    const toolCallIds = new Set(
      events.flatMap((event) =>
        event.blocks.flatMap((block) =>
          block.kind === "tool_use" && block.callId ? [block.callId] : [],
        ),
      ),
    );
    const pairedResults = new Map<string, PairedToolResult>();
    const pairedResultEventIds = new Set<number>();

    for (const event of events) {
      const resultBlocks = event.blocks
        .map((block, blockIndex) => ({ block, blockIndex }))
        .filter(({ block }) => block.kind === "tool_result");
      const isResultOnly = event.blocks.every(
        (block) => block.kind === "tool_result" || block.kind === "raw",
      );
      const canPairEveryResult = resultBlocks.every(
        ({ block }) => block.callId && toolCallIds.has(block.callId),
      );
      if (!isResultOnly || resultBlocks.length === 0 || !canPairEveryResult) continue;

      pairedResultEventIds.add(event.index);
      const includesRawEvent = event.blocks.some((block) => block.kind === "raw");
      resultBlocks.forEach(({ block, blockIndex }, resultIndex) => {
        pairedResults.set(block.callId!, {
          block,
          eventIndex: event.index,
          blockIndex,
          includesRawEvent: includesRawEvent && resultIndex === 0,
        });
      });
    }

    const displayEvents = events.filter((event) => !pairedResultEventIds.has(event.index));
    return {
      items: buildActivityDisplayItems(displayEvents),
      allEventIds: displayEvents.map((event) => event.index),
      pairedToolResults: pairedResults,
    };
  }, [events]);

  const allCollapsed = allEventIds.length > 0 && allEventIds.every((id) => collapsed.has(id));

  const toggleEvent = useCallback((eventIdx: number) => {
    pause();
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(eventIdx)) next.delete(eventIdx); else next.add(eventIdx);
      return next;
    });
  }, [pause]);

  const collapseAll = useCallback(() => {
    pause();
    setCollapsed(new Set(allEventIds));
  }, [allEventIds, pause]);
  const expandAll = useCallback(() => {
    pause();
    setCollapsed(new Set());
  }, [pause]);

  const rowVirtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (i) => {
      const it = items[i];
      if (!it) return 96;
      if (collapsed.has(it.ev.index)) return 40;
      return 96;
    },
    overscan: 8,
    // Key by event identity (not index) so that when loadOlder prepends a
    // page and every existing event's array index shifts, the virtualizer
    // keeps its cached measurements. Without this, scrolling up after a
    // prepend causes a wave of re-measurements that flickers visible text.
    // virtual-core's default scroll-anchoring on size-change does the rest.
    getItemKey: (i) => {
      const it = items[i];
      if (!it) return i;
      return `${it.kind}-${it.ev.index}`;
    },
  });

  const virtualItems = rowVirtualizer.getVirtualItems();
  const totalSize = rowVirtualizer.getTotalSize();

  // Most recent USER event that has scrolled past the top of the viewport.
  // Recomputed whenever the virtualizer reports new visible items (i.e., on
  // every scroll). Reads scrollTop directly rather than tracking it in state
  // to keep scroll re-renders cheap.
  const stickyUser = useMemo<ActivityEvent | null>(() => {
    const el = parentRef.current;
    if (!el || items.length === 0) return null;
    const scrollTop = el.scrollTop;
    // measurementsCache is the public mirror of the private getMeasurements();
    // it's refreshed by the getVirtualItems() call above on every render, so
    // it holds current start/size for every row, including those scrolled off.
    const measurements = rowVirtualizer.measurementsCache;
    // Threshold = "anything whose top has reached the bottom edge of the
    // sticky bar". As the user msg approaches the top of the viewport, the
    // sticky flips to it the moment its top would slip behind the bar; on
    // scroll-up, it flips back to the previous user once that row's top
    // re-emerges below the bar. Falls back to a 52px estimate before the
    // sticky has rendered for the first time so the math is stable on cold
    // start.
    const stickyH = stickyHeaderRef.current?.offsetHeight ?? 52;
    const threshold = scrollTop + stickyH;
    let bestEv: ActivityEvent | null = null;
    for (let i = 0; i < measurements.length && i < items.length; i++) {
      const m = measurements[i];
      if (!m) continue;
      if (m.start > threshold) break;
      const it = items[i];
      if (it && it.kind === "user") bestEv = it.ev;
    }
    return bestEv;
    // virtualItems is the proxy for "scroll position changed".
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [virtualItems, items]);

  // Event row currently straddling the top of the viewport: its header has
  // scrolled past, but its content is still on screen. Drives the secondary
  // sticky which lets the viewer jump back to that row's start.
  const stickyCurrent = useMemo<{ item: DisplayItem; index: number } | null>(() => {
    const el = parentRef.current;
    if (!el || items.length === 0) return null;
    const scrollTop = el.scrollTop;
    const measurements = rowVirtualizer.measurementsCache;
    const userStickyH = stickyUser ? (stickyHeaderRef.current?.offsetHeight ?? 52) : 0;
    const threshold = scrollTop + userStickyH;
    for (let i = 0; i < measurements.length && i < items.length; i++) {
      const m = measurements[i];
      if (!m) continue;
      if (m.start > threshold) break;
      if (m.start + m.size <= threshold) continue;
      // Row straddles threshold. Require >=24px hidden so the row's own
      // header is actually obscured, else the secondary would just duplicate
      // what's already on screen.
      if (threshold - m.start < 24) return null;
      const it = items[i];
      if (!it) return null;
      // Compaction banners are milestones, not turns — never pin them as
      // the secondary sticky (the role chip would be meaningless).
      if (it.kind === "compaction") return null;
      // Primary sticky already represents this row.
      if (it.kind === "user" && stickyUser && stickyUser.index === it.ev.index) return null;
      return { item: it, index: i };
    }
    return null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [virtualItems, items, stickyUser]);

  const jumpToStickyCurrent = useCallback(() => {
    if (!stickyCurrent) return;
    const el = parentRef.current;
    const m = rowVirtualizer.measurementsCache[stickyCurrent.index];
    if (!el || !m) return;
    const userStickyH = stickyUser ? (stickyHeaderRef.current?.offsetHeight ?? 0) : 0;
    pause();
    el.scrollTop = Math.max(0, m.start - userStickyH);
    flashHighlight(stickyCurrent.item.ev.index);
  }, [stickyCurrent, stickyUser, rowVirtualizer, flashHighlight, pause]);

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

  if (loading && events.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-[13px] text-muted-foreground">
        loading session events…
      </div>
    );
  }
  if (error && events.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-[13px] text-destructive">
        {error}
      </div>
    );
  }
  if (events.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-[13px] text-muted-foreground">
        no events
      </div>
    );
  }

  return (
    <div className="relative flex h-full flex-col">
      <div
        className="flex shrink-0 items-center gap-3 border-b border-border bg-muted/10 px-4 py-2.5 font-mono"
        style={{ fontSize: "var(--agent-panel-fs-tile-chip, 12px)" }}
      >
        <button
          type="button"
          onClick={allCollapsed ? expandAll : collapseAll}
          disabled={allEventIds.length === 0}
          title={allCollapsed ? "Expand all agent sections" : "Collapse all agent sections"}
          className="flex items-center gap-2 rounded-md px-3 py-1.5 font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
        >
          {allCollapsed ? <UnfoldVertical className="size-[1.2em]" aria-hidden /> : <FoldVertical className="size-[1.2em]" aria-hidden />}
          {allCollapsed ? "expand all" : "collapse all"}
        </button>
      </div>
      <div className="relative flex-1 overflow-hidden">
        <div ref={parentRef} onScroll={onScroll} className="h-full overflow-y-auto">
          <div
            ref={sizedRef}
            style={{
              height: rowVirtualizer.getTotalSize(),
              position: "relative",
              width: "100%",
            }}
          >
            {virtualItems.map((virtualRow) => {
              const it = items[virtualRow.index];
              if (!it) return null;
              return (
                <div
                  key={`${it.kind}-${it.ev.index}`}
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
                  {it.kind === "user" ? (
                    <UserRow
                      ev={it.ev}
                      source={source}
                      sessionId={sessionId}
                      isCollapsed={collapsed.has(it.ev.index)}
                      onToggle={() => toggleEvent(it.ev.index)}
                      isHighlighted={highlightedEvIdx === it.ev.index}
                      expandedTools={expandedTools}
                      onToggleTool={toggleTool}
                      pairedToolResults={pairedToolResults}
                    />
                  ) : it.kind === "compaction" ? (
                    <CompactionRow
                      ev={it.ev}
                      source={source}
                      sessionId={sessionId}
                    />
                  ) : (
                    <SegmentEventRow
                      ev={it.ev}
                      source={source}
                      sessionId={sessionId}
                      isFirst={it.isFirst}
                      isLast={it.isLast}
                      isCollapsed={collapsed.has(it.ev.index)}
                      onToggle={() => toggleEvent(it.ev.index)}
                      isHighlighted={highlightedEvIdx === it.ev.index}
                      expandedTools={expandedTools}
                      onToggleTool={toggleTool}
                      pairedToolResults={pairedToolResults}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </div>
        {(stickyUser || stickyCurrent) ? (
          <div className="absolute inset-x-0 top-0 z-20 flex flex-col">
            {stickyUser ? (
              <StickyUserHeader
                ev={stickyUser}
                buttonRef={stickyHeaderRef}
                onClick={() => {
                  const idx = items.findIndex(
                    (it) => it.kind === "user" && it.ev.index === stickyUser.index,
                  );
                  if (idx < 0) return;
                  const el = parentRef.current;
                  const m = rowVirtualizer.measurementsCache[idx];
                  if (!el || !m) return;
                  // Land the row's top exactly stickyH pixels into the viewport
                  // in one synchronous scroll write. The previous two-step (jump
                  // to row top, then rAF-correct by stickyH) showed the row
                  // briefly under the bar before sliding into place.
                  const stickyH = stickyHeaderRef.current?.offsetHeight ?? 0;
                  pause();
                  el.scrollTop = Math.max(0, m.start - stickyH);
                  flashHighlight(stickyUser.index);
                }}
              />
            ) : null}
            {stickyCurrent ? (
              <StickyEventHeader item={stickyCurrent.item} onClick={jumpToStickyCurrent} />
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
    </div>
  );
}

const ROLE_STYLES: Record<DisplayRole, string> = {
  user: "bg-primary/15 text-primary",
  assistant: "bg-muted text-foreground/80",
  tool: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  result: "bg-foreground/10 text-foreground/70",
  // Reasoning is the model's internal thought; muted so it reads as
  // commentary, not headline.
  reasoning: "bg-violet-500/15 text-violet-600 dark:text-violet-300",
  system: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
};

// Solid accent line per role, used as the left border on the secondary
// sticky so the role is recognizable at a glance.
const ROLE_BORDER: Record<DisplayRole, string> = {
  user: "border-l-primary",
  assistant: "border-l-muted-foreground/50",
  tool: "border-l-amber-500",
  result: "border-l-foreground/40",
  reasoning: "border-l-violet-500",
  system: "border-l-sky-500",
};

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
  const text = ev.blocks.find((b) => b.kind === "text")?.text ?? "";
  const preview = text.split("\n")[0]!.trim().slice(0, 200);
  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={onClick}
      title="jump to message"
      className="flex w-full items-center gap-3 border-b border-primary/40 bg-card px-4 py-3 text-left shadow-sm transition-colors hover:bg-muted"
      style={{ fontSize: "var(--agent-panel-fs-tile-other-text, 14px)" }}
    >
      <span className="shrink-0 rounded-md bg-primary/30 px-2 py-1 font-mono text-(length:--agent-panel-fs-tile-chip,12px) font-semibold uppercase tracking-wider text-primary">
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
// whose header has scrolled behind the bar while its content is still on
// screen. Click jumps to that row's start.
function StickyEventHeader({
  item, onClick,
}: {
  item: DisplayItem;
  onClick: () => void;
}) {
  const ev = item.ev;
  const role: DisplayRole = item.kind === "user" ? "user" : displayRole(ev);
  let preview = "";
  for (const b of ev.blocks) {
    if (b.kind === "text" && b.text) { preview = b.text; break; }
    if (b.kind === "tool_use") { preview = b.summary || b.tool || ""; break; }
    if (b.kind === "tool_result" && b.preview) { preview = b.preview; break; }
    if (b.kind === "reasoning" && b.text) { preview = b.text; break; }
  }
  preview = preview.split("\n")[0]!.trim().slice(0, 200);
  return (
    <button
      type="button"
      onClick={onClick}
      title="jump to event start"
      className={
        "flex w-full items-center gap-[0.55em] border-b border-l-[3px] border-border bg-card/95 px-4 py-2 text-left shadow-sm backdrop-blur transition-colors hover:bg-muted " +
        ROLE_BORDER[role]
      }
      style={{ fontSize: "var(--agent-panel-fs-tile-other-text, 14px)" }}
    >
      <ChevronRight
        className="size-[1.1em] shrink-0 rotate-90 text-muted-foreground"
        aria-hidden
      />
      <span
        className={
          "shrink-0 rounded-sm px-[0.55em] py-[0.15em] font-mono text-(length:--agent-panel-fs-tile-chip,12px) font-bold uppercase tracking-wider " +
          ROLE_STYLES[role]
        }
      >
        {role}
      </span>
      <span className="shrink-0 font-mono text-(length:--agent-panel-fs-tile-chip,12px) text-muted-foreground">
        #{ev.index}
      </span>
      <span className="min-w-0 flex-1 truncate text-muted-foreground">
        {preview}
      </span>
    </button>
  );
}

function UserRow({
  ev, source, sessionId, isCollapsed, onToggle, isHighlighted, expandedTools, onToggleTool,
  pairedToolResults,
}: {
  ev: ActivityEvent;
  source: AgentSource;
  sessionId: string;
  isCollapsed: boolean;
  onToggle: () => void;
  isHighlighted: boolean;
  expandedTools: Set<string>;
  onToggleTool: (key: string) => void;
  pairedToolResults: ReadonlyMap<string, PairedToolResult>;
}) {
  return (
    <div
      className="px-[0.85em] py-[0.85em]"
      style={{ fontSize: "var(--agent-panel-fs-tile-other-text, 14px)" }}
    >
      <div
        className={
          "rounded-md border border-primary/30 bg-primary/10 px-[1.15em] py-[0.55em] transition-shadow duration-300 " +
          (isHighlighted ? "ring-2 ring-primary ring-offset-2 ring-offset-background" : "")
        }
      >
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={!isCollapsed}
          aria-label={isCollapsed ? "expand event" : "collapse event"}
          className="flex w-full items-center gap-[0.55em] rounded-sm py-[0.3em] text-left transition-colors hover:bg-foreground/5"
        >
          <ChevronRight
            className={
              "size-[1.1em] shrink-0 text-muted-foreground transition-transform " +
              (isCollapsed ? "" : "rotate-90")
            }
            aria-hidden
          />
          <span
            className={
              "rounded-sm px-[0.55em] py-[0.15em] font-mono text-(length:--agent-panel-fs-tile-chip,12px) font-bold uppercase tracking-wider " +
              ROLE_STYLES.user
            }
          >
            user
          </span>
          <span className="font-mono text-(length:--agent-panel-fs-tile-chip,12px) text-muted-foreground">#{ev.index}</span>
          <span className="font-mono text-(length:--agent-panel-fs-tile-chip,12px) text-muted-foreground">
            {ev.ts ? new Date(ev.ts).toLocaleTimeString() : "–"}
          </span>
        </button>
        {!isCollapsed ? (
          <div className="space-y-[0.55em] pl-[1.65em] pt-[0.3em]">
            {ev.blocks.map((b, i) => (
            <Block key={i} b={b} source={source} sessionId={sessionId} eventIndex={ev.index} blockIndex={i} eventType={ev.type} expandedTools={expandedTools} onToggleTool={onToggleTool} pairedToolResults={pairedToolResults} />
          ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function SegmentEventRow({
  ev, source, sessionId, isFirst, isLast, isCollapsed, onToggle, isHighlighted, expandedTools, onToggleTool,
  pairedToolResults,
}: {
  ev: ActivityEvent;
  source: AgentSource;
  sessionId: string;
  isFirst: boolean;
  isLast: boolean;
  isCollapsed: boolean;
  onToggle: () => void;
  isHighlighted: boolean;
  expandedTools: Set<string>;
  onToggleTool: (key: string) => void;
  pairedToolResults: ReadonlyMap<string, PairedToolResult>;
}) {
  const role = displayRole(ev);
  const wrapperClass =
    "border-x border-border bg-muted/60 px-[0.85em] transition-shadow duration-300 " +
    (isFirst ? "rounded-t-md border-t pt-[0.55em] " : "pt-[0.4em] ") +
    (isLast ? "rounded-b-md border-b pb-[0.55em] " : "pb-[0.4em] ") +
    (!isLast ? "border-b border-dashed border-border/60 " : "") +
    (isHighlighted ? "ring-2 ring-primary ring-offset-2 ring-offset-background " : "");
  return (
    <div
      className={"px-[0.85em] " + (isFirst ? "pt-[0.55em] " : "") + (isLast ? "pb-[0.55em]" : "")}
      style={{ fontSize: "var(--agent-panel-fs-tile-other-text, 14px)" }}
    >
      <div className={wrapperClass}>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={!isCollapsed}
          aria-label={isCollapsed ? "expand event" : "collapse event"}
          className="flex w-full items-center gap-[0.55em] rounded-sm py-[0.3em] text-left transition-colors hover:bg-foreground/5"
        >
          <ChevronRight
            className={
              "size-[1.1em] shrink-0 text-muted-foreground transition-transform " +
              (isCollapsed ? "" : "rotate-90")
            }
            aria-hidden
          />
          <span
            className={
              "rounded-sm px-[0.55em] py-[0.15em] font-mono text-(length:--agent-panel-fs-tile-chip,12px) font-bold uppercase tracking-wider " +
              ROLE_STYLES[role]
            }
          >
            {role}
          </span>
          <span className="font-mono text-(length:--agent-panel-fs-tile-chip,12px) text-muted-foreground">#{ev.index}</span>
          <span className="font-mono text-(length:--agent-panel-fs-tile-chip,12px) text-muted-foreground">
            {ev.ts ? new Date(ev.ts).toLocaleTimeString() : "–"}
          </span>
        </button>
        {!isCollapsed ? (
          <div className="space-y-[0.55em] pl-[1.65em] pt-[0.3em]">
            {ev.blocks.map((b, i) => (
            <Block key={i} b={b} source={source} sessionId={sessionId} eventIndex={ev.index} blockIndex={i} eventType={ev.type} expandedTools={expandedTools} onToggleTool={onToggleTool} pairedToolResults={pairedToolResults} />
          ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

// `.md` / `.mdx` file detection for tool calls whose body should render as
// formatted Markdown rather than raw source.
function isMarkdownPath(p: unknown): p is string {
  return typeof p === "string" && /\.mdx?$/i.test(p);
}

// Claude `Read` results are `cat -n` output: every line is prefixed with
// optional leading spaces, the line number, then a tab. Strip that prefix to
// recover the source Markdown. (Repo convention documents the "line number +
// tab" shape.) Non-prefixed lines pass through untouched.
function stripReadLineNumbers(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/^\s*\d+\t/, ""))
    .join("\n");
}

function ToolResultBlock({
  block,
  renderMarkdown,
}: {
  block: ActivityBlock;
  renderMarkdown?: boolean;
}) {
  const showing = block.preview ?? "";

  return (
    <div
      className="rounded-sm border border-border/50 bg-muted/30"
      style={{ fontSize: "var(--agent-panel-fs-tile-other-text, 14px)" }}
    >
      {renderMarkdown ? (
        <div className="px-2 py-1.5">
          <Markdown content={stripReadLineNumbers(showing)} />
        </div>
      ) : (
        <pre className="whitespace-pre-wrap wrap-break-word px-2 py-1.5 font-mono text-foreground/70">
          {showing}
        </pre>
      )}
    </div>
  );
}

function ToolResultContent({
  result,
  source,
  sessionId,
}: {
  result: PairedToolResult;
  source: AgentSource;
  sessionId: string;
}) {
  const content = result.block.preview ? (
    <ToolResultBlock
      block={result.block}
    />
  ) : (
    <LabeledTextBlock
      block={{ ...result.block, kind: "plain", label: "Tool Result", text: "(empty result)" }}
    />
  );

  return (
    <div className="space-y-1.5">
      {content}
      {result.includesRawEvent ? (
        <RawJsonBlock
          source={source}
          sessionId={sessionId}
          eventIndex={result.eventIndex}
        />
      ) : null}
    </div>
  );
}

function Block({
  b, source, sessionId, eventIndex, blockIndex, eventType, expandedTools, onToggleTool,
  pairedToolResults,
}: {
  b: ActivityBlock;
  source: AgentSource;
  sessionId: string;
  eventIndex: number;
  blockIndex: number;
  eventType: ActivityEvent["type"];
  expandedTools: Set<string>;
  onToggleTool: (key: string) => void;
  pairedToolResults: ReadonlyMap<string, PairedToolResult>;
}) {
  if (b.kind === "text") {
    // Assistant text is the model's prose response; it conventionally
    // contains markdown (headings, code fences, lists, tables) that should
    // render rather than show as raw source. User text and tool textual
    // payloads stay plain so escaping characters survive.
    if (eventType === "assistant" && b.text) {
      return (
        <div
          className="leading-snug text-foreground"
          style={{ fontSize: "var(--agent-panel-fs-tile-other-text, 14px)" }}
        >
          <Markdown content={b.text} />
        </div>
      );
    }
    return (
      <div
        className="whitespace-pre-wrap break-words leading-snug text-foreground"
        style={{ fontSize: "var(--agent-panel-fs-tile-other-text, 14px)" }}
      >
        {b.text}
      </div>
    );
  }
  if (b.kind === "tool_use") {
    const toolKey = b.callId ?? `${eventIndex}-${blockIndex}`;
    const pairedResult = b.callId ? pairedToolResults.get(b.callId) : undefined;
    const isExpanded = expandedTools.has(toolKey);
    // Edit tool gets a custom header (filename) and a diff body. Generic
    // tools get chip+summary as header. A matching result expands inside this
    // same block instead of consuming a second source-line row.
    const isEditDiff =
      b.tool === "Edit" &&
      b.input &&
      typeof b.input.file_path === "string" &&
      ((typeof b.input.old_string === "string" && b.input.old_string.length > 0) ||
        (typeof b.input.new_string === "string" && b.input.new_string.length > 0));
    const isMarkdownWrite =
      b.tool === "Write" && isMarkdownPath(b.input?.file_path) && typeof b.input?.content === "string";
    const isFileBody = isEditDiff || isMarkdownWrite;
    const hasBody = isFileBody || pairedResult !== undefined;
    const headerLabel = isFileBody
      ? (typeof b.input?.file_path === "string" ? b.input.file_path.split("/").pop() ?? "" : "")
      : (b.summary || "");
    const headerChip = isEditDiff ? "Edit" : b.tool;
    return (
      <div className="space-y-1.5">
        <button
          type="button"
          onClick={() => hasBody && onToggleTool(toolKey)}
          aria-expanded={isExpanded}
          disabled={!hasBody}
          className={
            "flex w-full items-baseline gap-2 rounded-sm font-mono text-left transition-colors " +
            (hasBody ? "hover:bg-foreground/5 " : "cursor-default ")
          }
          style={{ fontSize: "var(--agent-panel-fs-tile-other-text, 14px)" }}
        >
          {hasBody ? (
            <ChevronRight
              className={
                "size-[1em] shrink-0 self-center text-muted-foreground transition-transform " +
                (isExpanded ? "rotate-90" : "")
              }
              aria-hidden
            />
          ) : (
            <span className="size-[1em] shrink-0" aria-hidden />
          )}
          <span className="shrink-0 rounded-sm bg-muted px-1.5 py-0.5 text-(length:--agent-panel-fs-tile-chip,12px) font-semibold text-foreground/80">
            {headerChip}
          </span>
          <span className="min-w-0 flex-1 truncate text-foreground/80">
            {headerLabel}
          </span>
        </button>
        {isExpanded ? (
          <>
            {isEditDiff ? (
              <DiffBlock
                filePath={b.input!.file_path as string}
                oldString={(b.input!.old_string as string | undefined) ?? ""}
                newString={(b.input!.new_string as string | undefined) ?? ""}
              />
            ) : null}
            {isMarkdownWrite ? (
              <Markdown content={b.input!.content as string} />
            ) : null}
            {pairedResult ? (
              <ToolResultContent
                result={pairedResult}
                source={source}
                sessionId={sessionId}
              />
            ) : null}
          </>
        ) : null}
      </div>
    );
  }
  if (b.kind === "tool_result") {
    return (
      <ToolResultContent
        result={{
          block: b,
          eventIndex,
          blockIndex,
          includesRawEvent: false,
        }}
        source={source}
        sessionId={sessionId}
      />
    );
  }
  if (b.kind === "reasoning") {
    if (!b.text) return null;
    return (
      <div
        className="whitespace-pre-wrap break-words italic leading-snug text-foreground/65"
        style={{ fontSize: "var(--agent-panel-fs-tile-reasoning, 13px)" }}
      >
        {b.text}
      </div>
    );
  }
  if (b.kind === "metadata" || b.kind === "plain") {
    return <LabeledTextBlock block={b} />;
  }
  if (b.kind === "raw") {
    return (
      <RawJsonBlock
        source={source}
        sessionId={sessionId}
        eventIndex={eventIndex}
      />
    );
  }
  // Compaction blocks render as a full-row banner via CompactionRow, not
  // inline. Returning null here keeps any stray inline render path silent.
  return null;
}

// Horizontal milestone banner that marks where the harness compacted the
// model's context. Sits between turn clusters so the viewer can see the
// reset point; the actual context-size drop is already visible in the
// header token meter.
function CompactionRow({
  ev,
  source,
  sessionId,
}: {
  ev: ActivityEvent;
  source: AgentSource;
  sessionId: string;
}) {
  const when = ev.ts ? new Date(ev.ts).toLocaleTimeString() : "";
  return (
    <div
      className="px-[0.85em] py-[0.85em]"
      style={{ fontSize: "var(--agent-panel-fs-tile-other-text, 14px)" }}
    >
      <div className="flex items-center gap-3 text-muted-foreground">
        <span className="h-px flex-1 bg-border" aria-hidden />
        <span
          className="flex shrink-0 items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-0.5 font-mono uppercase tracking-wider text-foreground/70"
          style={{ fontSize: "var(--agent-panel-fs-tile-chip, 12px)" }}
        >
          <span>Context compacted</span>
          {when ? <span className="text-muted-foreground/70">{when}</span> : null}
        </span>
        <span className="h-px flex-1 bg-border" aria-hidden />
      </div>
      <div className="mt-2">
        <RawJsonBlock
          source={source}
          sessionId={sessionId}
          eventIndex={ev.index}
        />
      </div>
    </div>
  );
}
