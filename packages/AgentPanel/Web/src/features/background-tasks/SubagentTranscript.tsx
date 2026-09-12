import { useCallback, useMemo } from "react";
import {
  ClusterRow,
  CompactionRow,
  type EventRowContext,
  SegmentEventRow,
  UserRow,
} from "@/features/activity-feed/blocks/ActivityEventRows";
import type {
  AgentDataSource,
  SessionReference,
} from "@/features/activity-feed/data-source/AgentDataSource";
import { useFeedRows } from "@/features/activity-feed/rows/useFeedRows";
import { itemKey } from "@/features/activity-feed/rows/activityDisplayItems";
import { useSubagentTranscript } from "@/features/background-tasks/useSubagentTranscript";

/**
 * A subagent's transcript, rendered by the same path a session's own transcript is.
 *
 * `useFeedRows` and the row components ARE the renderer -- clustering, per-event collapse, tool
 * pairing, streaming prose, diffs. A second renderer for the same events would drift from this one
 * the moment either changed, and the reader would be told the same data in two different shapes.
 *
 * What this does NOT reuse is the feed's virtualizer, because it is not a feed: a run is small
 * (measured at 190 events against its parent's 7,935) and lives inside a task row that is already
 * scrollable, so a virtualizer here would nest one scroller in another to save nothing.
 *
 * The row context declares `rawSource: "unaddressable"`, which is the load-bearing line. These
 * events did not come from `session`'s transcript -- they come from the subagent's own file, read
 * THROUGH the session that launched it -- so an event index here names a line in a different file.
 * Handing the parent to a raw fetch would return an unrelated line and render it as this row's
 * source, with nothing about the result looking wrong. There is no raw-by-index route for a
 * subagent today, so the affordance is declared absent rather than left incidentally unreachable.
 */
export function SubagentTranscript({
  source,
  session,
  agentId,
}: {
  source: AgentDataSource;
  session: SessionReference;
  agentId: string;
}) {
  const view = useSubagentTranscript(source, session, agentId);

  // A run has no live tail: the tail is the sidecar's projection of a session that is generating
  // tokens, and nothing projects a subagent. Its events arrive as ordinary appends.
  const pause = useCallback(() => {}, []);
  const {
    collapsed,
    expandCluster,
    expandedTools,
    highlightedEvIdx,
    items,
    pairedToolResults,
    toggleEvent,
    toggleTool,
  } = useFeedRows({
    events: view.events,
    liveTail: null,
    mode: "nice",
    pause,
    source: session.source,
  });

  const rowContext: EventRowContext = useMemo(
    () => ({
      session,
      rawSource: "unaddressable",
      expandedTools,
      onToggleTool: toggleTool,
      pairedToolResults,
      showCacheHits: false,
      // No `onForkFromMessage`: forking branches a SESSION, and a subagent is not one. Absent
      // rather than disabled, which is how the feed's own rows already express this.
    }),
    [session, expandedTools, toggleTool, pairedToolResults],
  );

  if (view.unavailable) {
    return <p className="px-3 py-2 text-xs text-muted-foreground">{view.unavailable}</p>;
  }
  if (!view.loaded) {
    return <p className="px-3 py-2 text-xs text-muted-foreground">Opening transcript…</p>;
  }
  if (view.events.length === 0) {
    // Loaded and genuinely empty, which is a launched run that has not written yet rather than a
    // failure. Said differently from `unavailable` on purpose.
    return <p className="px-3 py-2 text-xs text-muted-foreground">Nothing written yet.</p>;
  }

  return (
    <div className="border-t border-border">
      {view.forkOrigin ? (
        <p className="px-3 py-1.5 text-[11px] text-muted-foreground">
          Forked with {view.forkOrigin.contextLength.toLocaleString()} messages of context
        </p>
      ) : null}
      {/* Capped and scrolled rather than growing the panel: a long run would otherwise push every
          other task off the screen. */}
      <div className="max-h-96 overflow-y-auto py-1">
        {items.map((item) => (
          <div key={itemKey(item)}>
            {item.kind === "cluster" ? (
              <ClusterRow
                events={item.events}
                isFirst
                isLast
                onExpand={() => expandCluster(item.events[0]!.index)}
              />
            ) : item.kind === "user" ? (
              <UserRow
                ev={item.ev}
                ctx={rowContext}
                isCollapsed={collapsed.has(item.ev.index)}
                onToggle={() => toggleEvent(item.ev.index)}
                isHighlighted={highlightedEvIdx === item.ev.index}
              />
            ) : item.kind === "compaction" ? (
              <CompactionRow ev={item.ev} ctx={rowContext} />
            ) : (
              <SegmentEventRow
                ev={item.ev}
                ctx={rowContext}
                isFirst={item.isFirst}
                isLast={item.isLast}
                isCollapsed={collapsed.has(item.ev.index)}
                onToggle={() => toggleEvent(item.ev.index)}
                isHighlighted={highlightedEvIdx === item.ev.index}
              />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
