"use client";

// The thread's controls, portalled into the shell header.
//
// One portal, not one per control: they share a row and their order is a layout decision,
// which belongs in one place. The transcript itself spends no band on them.

import { createPortal } from "react-dom";
import { FoldVertical, UnfoldVertical } from "lucide-react";
import type { EventMode } from "@/features/activity-feed/data-source/AgentDataSource";

export function ActivityFeedControls({
  allCollapsed,
  canToggleMode,
  collapseAll,
  controlsHost,
  expandAll,
  mode,
  onToggleMode,
  allEventIds,
  showCacheHits,
  onToggleCacheHits,
}: {
  allCollapsed: boolean;
  canToggleMode: boolean;
  collapseAll: () => void;
  controlsHost: Element | null;
  expandAll: () => void;
  mode: EventMode;
  onToggleMode?: () => void;
  allEventIds: number[];
  showCacheHits: boolean;
  onToggleCacheHits?: () => void;
}) {
  if (!controlsHost) return null;
  return createPortal(
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
              : "session-muted-ink hover:bg-muted hover:text-foreground active:bg-muted/80")
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
              : "session-muted-ink hover:bg-muted hover:text-foreground active:bg-muted/80")
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
          className="flex h-8 w-8 items-center justify-center rounded-lg session-muted-ink transition-colors hover:bg-muted hover:text-foreground active:bg-muted/80 disabled:opacity-40"
        >
          {allCollapsed ? (
            <UnfoldVertical className="h-4 w-4" aria-hidden />
          ) : (
            <FoldVertical className="h-4 w-4" aria-hidden />
          )}
        </button>
    </>,
    controlsHost,
  );
}
