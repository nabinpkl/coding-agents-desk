"use client";

// Which rows the transcript has, and which of them are open.
//
// One hook because the two questions are the same question: clustering depends on which
// clusters the reader expanded, and the row list is what "collapse all" is all of. Every
// setter pauses the tail-follower first, since a restructure the reader asked for must not
// be answered by snapping back to the bottom.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ActivityEvent } from "./useSessionEventsStream";
import type { EventMode, AgentSource } from "./data-source/AgentDataSource";
import type { DisplayItem } from "./activityDisplayItems";
import { buildFeedLayout } from "./activityFeedLayout";

export function useFeedRows({
  events,
  liveTail,
  mode,
  pause,
  source,
}: {
  events: ActivityEvent[];
  liveTail: ActivityEvent | null;
  mode: EventMode;
  /** Detaches the tail-follower, because every restructure below is the reader's own. */
  pause: () => void;
  source: AgentSource;
}) {
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

  return {
    allCollapsed,
    allEventIds,
    clusterLeadIds,
    collapse: collapseAll,
    collapsed,
    expandAll,
    expandCluster,
    expandedTools,
    flashHighlight,
    highlightedEvIdx,
    items,
    liveTailCollapsed,
    pairedToolResults,
    rowItems,
    toggleEvent,
    toggleLiveTail,
    toggleTool,
  };
}
