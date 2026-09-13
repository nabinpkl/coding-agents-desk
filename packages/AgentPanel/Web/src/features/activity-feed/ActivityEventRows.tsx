"use client";

import { ChevronRight } from "lucide-react";
import { DiffBlock } from "./DiffBlock";
import { Markdown } from "./markdown/Markdown";
import { CodeBlock } from "./markdown/CodeBlock";
import { LabeledTextBlock, RawDetails } from "./ActivitySystemBlocks";
import {
  type DisplayRole,
  clusterLabel,
  displayRole,
} from "./activityDisplayItems";
import {
  eventPreview,
  isFlowBlock,
  shellCommand,
  toolIntent,
} from "./activityEventText";
import {
  type PairedToolResult,
  partitionEventBlocks,
} from "./activityFeedLayout";
import type { ActivityBlock, ActivityEvent, EventCacheHit } from "./useSessionEventsStream";
import type { SessionReference } from "./data-source/AgentDataSource";
import { Block } from "./ActivityBlockViews";
import {
  CacheBadge,
  CHIP_CLASS,
  EventHeading,
  FEED_ROW_GUTTER_CLASS,
  ROLE_STYLES,
  showEventRoleLabel,
} from "./ActivityEventHeading";

// Re-exported: the feed and its tests reach for the role label through the rows.
export {
  CacheBadge,
  ROLE_BORDER,
  ROLE_STYLES,
  showEventRoleLabel,
} from "./ActivityEventHeading";

/** What every row and block needs from the feed, bundled to stop prop drift. */
export interface EventRowContext {
  /** Identity AND mode together: every event index in these rows is counted in the
   *  mode, so a Raw fetch that knew one without the other would read a different
   *  line. */
  session: SessionReference;
  /** Tool-call keys whose body is open. */
  expandedTools: Set<string>;
  onToggleTool: (key: string) => void;
  pairedToolResults: ReadonlyMap<string, PairedToolResult>;
  /** Whether per-turn prompt-cache badges are rendered. */
  showCacheHits: boolean;
}

/**
 * What a collapsed event shows next to its chip.
 *
 * `overflow-hidden` is doing two jobs: it truncates, and it makes this box its
 * own formatting context so it is placed beside the floated heading rather
 * than under it. Collapsing used to reveal nothing but the chip, so a folded
 * thread was unreadable; a gist keeps it scannable.
 */
function CollapsedPreview({ ev }: { ev: ActivityEvent }) {
  const preview = eventPreview(ev);
  return (
    <div className="truncate py-[0.1em] leading-snug text-muted-foreground">
      {preview || "(no content)"}
    </div>
  );
}

/**
 * The expanded body of one event: its content blocks, then the single Raw
 * drawer holding the metadata and the raw transcript line.
 */
function EventBody({ ev, ctx }: { ev: ActivityEvent; ctx: EventRowContext }) {
  const { inline, folded, hasRawJson } = partitionEventBlocks(ev);
  return (
    <div className="space-y-[0.4em]">
      {inline.map(({ block, index }) => (
        // Non-flow blocks are bordered boxes, which would sit UNDER the floated
        // heading rather than beside it. Clearing keeps them below it instead of
        // overlapping. Once content extends past the heading's height this is a
        // no-op, so later blocks are unaffected.
        //
        // Keyed by kind as well as position: one reveal position lives inside the
        // block, and a slot that changed kind would hand a reasoning trace the
        // cursor prose left behind, showing a prefix of it until the catch-up
        // caught up. The kind is stable in practice, so this remounts nothing.
        <div key={`${index}-${block.kind}`} className={isFlowBlock(block) ? undefined : "clear-left"}>
          <Block
            b={block}
            ctx={ctx}
            eventIndex={ev.index}
            blockIndex={index}
            eventType={ev.type}
            phase={ev.phase}
          />
        </div>
      ))}
      <div className="clear-left">
        <RawDetails
          metadata={folded}
          session={ctx.session}
          eventIndex={ev.index}
          includesRawJson={hasRawJson}
        />
      </div>
    </div>
  );
}

/**
 * Shared shell for a collapsible event row.
 *
 * `flow-root` is required, not decorative: it makes this box contain the
 * floated heading, so a row whose body is shorter than its chip still measures
 * tall enough to hold it. Without it the float escapes and overlaps the next
 * row.
 */
function EventRowShell({
  ev,
  role,
  isCollapsed,
  onToggle,
  ctx,
  isLive = false,
}: {
  ev: ActivityEvent;
  role: DisplayRole;
  isCollapsed: boolean;
  onToggle: () => void;
  ctx: EventRowContext;
  isLive?: boolean;
}) {
  return (
    <div className="flow-root">
      <EventHeading
        ev={ev}
        role={role}
        isCollapsed={isCollapsed}
        onToggle={onToggle}
        showCacheHits={ctx.showCacheHits}
        isLive={isLive}
        // Nice reads as one continuous agent response, so prose and reasoning
        // do not repeat their role on every row. Raw keeps every role label.
        showRole={showEventRoleLabel(ctx.session.mode, role)}
      />
      {isCollapsed ? <CollapsedPreview ev={ev} /> : <EventBody ev={ev} ctx={ctx} />}
    </div>
  );
}

export function UserRow({
  ev, ctx, isCollapsed, onToggle, isHighlighted,
}: {
  ev: ActivityEvent;
  ctx: EventRowContext;
  isCollapsed: boolean;
  onToggle: () => void;
  isHighlighted: boolean;
}) {
  return (
    // Right-aligned, which is the one thing that separates what you said from what the session
    // said without reading either. The card shrinks to its text and stops at 85% of the row, so
    // the ragged left edge is the signal; a full-width card on the right would look the same as
    // every other row. Everything inside stays left-aligned -- prose, code and diffs are read
    // from a left margin whichever side of the feed they sit on.
    <div
      className={`${FEED_ROW_GUTTER_CLASS} flex justify-end py-[0.4em]`}
      style={{ fontSize: "var(--agent-panel-fs-tile-other-text, 16px)" }}
    >
      <div
        className={
          // `min-w-0` so a wide child (a pasted diff, a long unbroken path) scrolls inside the
          // card the way it does anywhere else, rather than forcing the card past its maximum.
          "min-w-0 max-w-[85%] rounded-md border border-primary/30 bg-primary/10 px-[0.6em] py-[0.35em] transition-shadow duration-300 " +
          (isHighlighted ? "ring-2 ring-primary ring-offset-2 ring-offset-background" : "")
        }
      >
        <EventRowShell
          ev={ev}
          role="user"
          isCollapsed={isCollapsed}
          onToggle={onToggle}
          ctx={ctx}
        />
      </div>
    </div>
  );
}

export function SegmentEventRow({
  ev, ctx, isFirst, isLast, isCollapsed, onToggle, isHighlighted, isLive = false,
}: {
  ev: ActivityEvent;
  ctx: EventRowContext;
  isFirst: boolean;
  isLast: boolean;
  isCollapsed: boolean;
  onToggle: () => void;
  isHighlighted: boolean;
  /** Still arriving: adds a pulse to the heading and changes nothing else. */
  isLive?: boolean;
}) {
  const role = displayRole(ev);
  const isNice = ctx.session.mode === "nice";
  const niceCardKind = role === "tool" || role === "result" ? "tool" : "text";
  const wrapperClass = isNice
    ? "rounded-md border px-[0.6em] py-[0.3em] transition-shadow duration-300 " +
      (niceCardKind === "tool"
        ? "border-border bg-muted/60 "
        : "border-border/60 bg-card ") +
      (isHighlighted ? "ring-2 ring-primary ring-offset-2 ring-offset-background " : "")
    : "border-x border-border bg-muted/60 px-[0.6em] transition-shadow duration-300 " +
      (isFirst ? "rounded-t-md border-t pt-[0.4em] " : "pt-[0.3em] ") +
      (isLast ? "rounded-b-md border-b pb-[0.4em] " : "pb-[0.3em] ") +
      (!isLast ? "border-b border-dashed border-border/60 " : "") +
      (isHighlighted ? "ring-2 ring-primary ring-offset-2 ring-offset-background " : "");
  const rowSpacing = isNice
    ? `${FEED_ROW_GUTTER_CLASS} py-[0.1em]`
    : FEED_ROW_GUTTER_CLASS + " " + (isFirst ? "pt-[0.4em] " : "") + (isLast ? "pb-[0.4em]" : "");
  return (
    <div
      className={rowSpacing}
      style={{ fontSize: "var(--agent-panel-fs-tile-other-text, 16px)" }}
    >
      <div className={wrapperClass} data-feed-card={isNice ? niceCardKind : undefined}>
        <EventRowShell
          ev={ev}
          role={role}
          isCollapsed={isCollapsed}
          onToggle={onToggle}
          ctx={ctx}
          isLive={isLive}
        />
      </div>
    </div>
  );
}

/**
 * The live in-flight assistant message, appended after the durable rows until the
 * transcript carries the same `messageId` and the durable row takes it over.
 *
 * Deliberately the SAME component a landed message renders in, with one pulsing dot
 * as the entire difference. It used to be its own card: a primary-tinted border, a
 * STREAMING band above the text, prose as pre-wrapped source, tools as `-> Bash`. So
 * the handoff re-chromed the row, re-rendered the same prose as Markdown, and
 * relabelled every tool call -- reflowing the paragraph the reader was in the middle
 * of, at the one moment they were reading it. Nothing about the message changed there;
 * only its renderer did. One renderer means the shape a message arrives in is the
 * shape it keeps, and the handoff is invisible.
 *
 * Its own rounded band rather than a continuation of the segment run above it: joining
 * that run would mean re-measuring the row above every time a turn starts and ends,
 * which is a layout shift bought to avoid a border radius.
 */
export function LiveTailRow({
  ev, ctx, isCollapsed, onToggle,
}: {
  ev: ActivityEvent;
  ctx: EventRowContext;
  isCollapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <SegmentEventRow
      ev={ev}
      ctx={ctx}
      isFirst
      isLast
      isCollapsed={isCollapsed}
      onToggle={onToggle}
      isHighlighted={false}
      isLive
    />
  );
}

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
  events, isFirst, isLast, onExpand,
}: {
  events: ActivityEvent[];
  isFirst: boolean;
  isLast: boolean;
  onExpand: () => void;
}) {
  const wrapperClass =
    "border-x border-border bg-muted/60 px-[0.6em] " +
    (isFirst ? "rounded-t-md border-t pt-[0.4em] " : "pt-[0.3em] ") +
    (isLast ? "rounded-b-md border-b pb-[0.4em] " : "pb-[0.3em] ") +
    (!isLast ? "border-b border-dashed border-border/60 " : "");
  return (
    <div
      className={FEED_ROW_GUTTER_CLASS + " " + (isFirst ? "pt-[0.4em] " : "") + (isLast ? "pb-[0.4em]" : "")}
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
          <ChevronRight
            className="size-[1.1em] shrink-0 text-muted-foreground"
            aria-hidden
          />
          <span className={CHIP_CLASS + ROLE_STYLES.tool}>tools</span>
          <span className="min-w-0 flex-1 truncate text-muted-foreground">
            {clusterLabel(events)}
          </span>
        </button>
      </div>
    </div>
  );
}

/**
 * Horizontal milestone banner that marks where the harness compacted the
 * model's context. Sits between turn clusters so the viewer can see the reset
 * point; the actual context-size drop is already visible in the header token
 * meter.
 */
export function CompactionRow({
  ev,
  ctx,
}: {
  ev: ActivityEvent;
  ctx: EventRowContext;
}) {
  const when = ev.ts ? new Date(ev.ts).toLocaleTimeString() : "";
  const { folded, hasRawJson } = partitionEventBlocks(ev);
  return (
    <div
      className={`${FEED_ROW_GUTTER_CLASS} py-[0.5em]`}
      style={{ fontSize: "var(--agent-panel-fs-tile-other-text, 16px)" }}
    >
      <div className="flex items-center gap-2 text-muted-foreground">
        <span className="h-px flex-1 bg-border" aria-hidden />
        <span
          className="flex shrink-0 items-center gap-1.5 rounded-full border border-border bg-card px-2 py-0.5 font-mono uppercase tracking-wider text-foreground/70"
          style={{ fontSize: "var(--agent-panel-fs-tile-chip, 12px)" }}
        >
          <span>Context compacted</span>
          {when ? <span className="text-muted-foreground/70">{when}</span> : null}
        </span>
        <span className="h-px flex-1 bg-border" aria-hidden />
      </div>
      <div className="mt-1">
        <RawDetails
          metadata={folded}
          session={ctx.session}
          eventIndex={ev.index}
          includesRawJson={hasRawJson}
        />
      </div>
    </div>
  );
}
