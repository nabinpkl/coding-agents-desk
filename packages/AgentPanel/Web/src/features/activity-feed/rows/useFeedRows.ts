"use client";

// Which rows the transcript has, and which of them are open.
//
// One hook because the two questions are the same question: clustering depends on which
// runs the reader folded, and the row list is what "collapse all" is all of. Every
// setter pauses the tail-follower first, since a restructure the reader asked for must not
// be answered by snapping back to the bottom.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ActivityEvent } from "@/features/activity-feed/useSessionEventsStream";
import type { EventMode, AgentSource } from "@/features/activity-feed/data-source/AgentDataSource";
import type { DisplayItem } from "@/features/activity-feed/rows/activityDisplayItems";
import { buildFeedLayout } from "@/features/activity-feed/rows/activityFeedLayout";

export function useFeedRows({
  events,
  liveTails,
  mode,
  pause,
  source,
}: {
  events: ActivityEvent[];
  liveTails: readonly ActivityEvent[];
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

  // Per-tool-call expansion: every row opens on click, including the newest
  // shell call. Auto-expanding the live edge turned long windows into a wall
  // of command output, so the feed stays a tight call list throughout.
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

  // Runs of tool work start open and fold only when the reader folds them. Not the
  // `collapsed` set, though both default to open: a run is keyed by its first event's
  // index, which is also that event's own row, and collapsing the row must not fold
  // the run.
  const [foldedClusters, setFoldedClusters] = useState<Set<number>>(new Set());
  const expandCluster = useCallback((leadIndex: number) => {
    pause();
    setFoldedClusters((previous) => {
      const next = new Set(previous);
      next.delete(leadIndex);
      return next;
    });
  }, [pause]);

  const { items, allEventIds, clusterLeadIds, pairedToolResults } = useMemo(
    // Clustering and scaffolding removal belong to Nice alone. Raw stays one
    // row per transcript line, which is the fidelity guarantee Nice leans on.
    () => buildFeedLayout(events, {
      cluster: mode === "nice",
      hideSystem: mode === "nice",
      incrementalReasoning: mode === "nice" && (source === "codex" || source === "opencode"),
      foldedClusters,
    }),
    [events, mode, source, foldedClusters],
  );

  // The part of the turn the transcript has not reached yet, appended after the
  // durable layout as one row per live message (the "live tail"). A turn is many
  // messages, so this is a list rather than a slot: each row streams until the
  // durable transcript carries that message, at which point the hook drops it and
  // the durable row owns it, while the rest of the turn stays previewed. Kept
  // separate from `items` so sticky/jump logic never treats them as real
  // conversation rows.
  const rowItems = useMemo(() => {
    const rows: Array<DisplayItem | { kind: "tail"; ev: ActivityEvent }> = [...items];
    for (const tail of liveTails) rows.push({ kind: "tail", ev: tail });
    return rows;
  }, [items, liveTails]);

  const allCollapsed =
    allEventIds.length > 0 &&
    allEventIds.every((id) => collapsed.has(id)) &&
    clusterLeadIds.every((lead) => foldedClusters.has(lead));

  const toggleEvent = useCallback((eventIdx: number) => {
    pause();
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(eventIdx)) next.delete(eventIdx); else next.add(eventIdx);
      return next;
    });
  }, [pause]);

  // The live rows' own collapse state, deliberately NOT a member of `collapsed`.
  //
  // Those are transcript indices. A live row's index is a position in the sidecar's live
  // projection -- a different space entirely, counted per session from the mirror's
  // first row, where the transcript counts lines. On a live thread the two overlap
  // constantly (a live row at 418 while the transcript is at 2965), so sharing the set
  // made collapsing one unrelated row hundreds of messages back also collapse the message
  // being written.
  //
  // Keyed by `liveRowKey`, which is the mirror's own row id, because the preview carries
  // the whole part of the turn the transcript has not reached and that is several rows.
  // A single boolean was right while it was one row and wrong the moment it was not: it
  // folded the entire turn away on a click meant for one message.
  const [collapsedTails, setCollapsedTails] = useState<Set<string>>(new Set());
  const toggleLiveTail = useCallback((key: string) => {
    pause();
    setCollapsedTails((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }, [pause]);

  const collapseAll = useCallback(() => {
    pause();
    setCollapsed(new Set(allEventIds));
    setFoldedClusters(new Set(clusterLeadIds));
  }, [allEventIds, clusterLeadIds, pause]);
  const expandAll = useCallback(() => {
    pause();
    setCollapsed(new Set());
    setFoldedClusters(new Set());
  }, [pause]);

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
    collapsedTails,
    items,
    pairedToolResults,
    rowItems,
    toggleEvent,
    toggleLiveTail,
    toggleTool,
  };
}
