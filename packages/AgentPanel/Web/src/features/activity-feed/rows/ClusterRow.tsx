"use client";

import { ChevronRight } from "lucide-react";
import { clusterLabel } from "@/features/activity-feed/rows/activityDisplayItems";
import { COLUMN_GUTTER_CLASS, TOOL_CARD_CLASS } from "@/features/activity-feed/blocks/ActivityEventHeading";
import type { ActivityEvent } from "@/features/activity-feed/useSessionEventsStream";

/**
 * A folded run of tool work, as one row.
 *
 * Tool calls and their output are the bulk of a transcript -- 54 of every 100 rows in
 * this project's largest Codex session -- and almost none of them is what a viewer
 * scrolling back is looking for. Folding a run into one line is what puts prose and
 * reasoning within a screen of each other again. A skill activation or a delegation
 * is never inside one: those change what the agent is doing, and hiding them would
 * hide the line that explains the next twenty.
 */
export function ClusterRow({
  events,
  isFirst,
  isLast,
  onExpand,
}: {
  events: ActivityEvent[];
  isFirst: boolean;
  isLast: boolean;
  onExpand: () => void;
}) {
  const wrapperClass =
    `border-x ${TOOL_CARD_CLASS} px-[0.6em] ` +
    (isFirst ? "rounded-t-md border-t pt-[0.4em] " : "pt-[0.3em] ") +
    (isLast ? "rounded-b-md border-b pb-[0.4em] " : "pb-[0.3em] ") +
    (!isLast ? "border-b border-dashed border-border/60 " : "");
  return (
    <div
      className={COLUMN_GUTTER_CLASS + " " + (isFirst ? "pt-[0.4em] " : "") + (isLast ? "pb-[0.4em]" : "")}
      style={{ fontSize: "var(--agent-panel-fs-tile-other-text, 16px)" }}
    >
      <div className={wrapperClass}>
        <button
          type="button"
          onClick={onExpand}
          aria-expanded={false}
          title={`Expand ${events.length} folded steps`}
          className="flex w-full items-center gap-[0.4em] text-left transition-colors hover:bg-foreground/5"
        >
          <ChevronRight className="size-[1.1em] shrink-0 text-muted-foreground" aria-hidden />
          <span className="min-w-0 flex-1 truncate text-muted-foreground">{clusterLabel(events)}</span>
        </button>
      </div>
    </div>
  );
}
