"use client";

import { ChevronDown, ChevronRight, GitBranch } from "lucide-react";
import { DiffBlock } from "@/features/activity-feed/blocks/diff/DiffBlock";
import { Markdown } from "@/features/activity-feed/markdown/Markdown";
import { CodeBlock } from "@/features/activity-feed/markdown/CodeBlock";
import { LabeledTextBlock, RawDetails } from "@/features/activity-feed/blocks/ActivitySystemBlocks";
import {
  type DisplayRole,
  clusterLabel,
  displayRole,
} from "@/features/activity-feed/rows/activityDisplayItems";
import {
  eventPreview,
  isFlowBlock,
  messageText,
  shellCommand,
  toolIntent,
} from "@/features/activity-feed/rows/activityEventText";
import { RowMenu } from "@/features/bots/menus/RowMenu";
import {
  pairSameEventToolResults,
  type PairedToolResult,
  partitionEventBlocks,
  withoutPairedToolResults,
} from "@/features/activity-feed/rows/activityFeedLayout";
import type { ActivityBlock, ActivityEvent, EventCacheHit } from "@/features/activity-feed/useSessionEventsStream";
import type { SessionReference } from "@/features/activity-feed/data-source/AgentDataSource";
import { Block } from "@/features/activity-feed/blocks/ActivityBlockViews";
import {
  CacheBadge,
  EventHeading,
  COLUMN_GUTTER_CLASS,
  showEventRoleLabel,
} from "@/features/activity-feed/blocks/ActivityEventHeading";

// Re-exported: the feed reaches for every row through this module.
export { CompactionRow } from "@/features/activity-feed/blocks/CompactionRow";

// Re-exported: the feed and its tests reach for the role label through the rows.
export {
  CacheBadge,
  ROLE_BORDER,
  ROLE_STYLES,
  showEventRoleLabel,
} from "@/features/activity-feed/blocks/ActivityEventHeading";

/** What every row and block needs from the feed, bundled to stop prop drift. */
export interface EventRowContext {
  /** Identity AND mode together: every event index in these rows is counted in the
   *  mode, so a Raw fetch that knew one without the other would read a different
   *  line. */
  session: SessionReference;
  /**
   * Whether these events came from `session`'s own transcript, so an event index names a line
   * that can be fetched back.
   *
   * `"unaddressable"` for a feed whose events belong to something else read THROUGH this session
   * -- today that is a subagent's run, whose records carry the parent's session id and whose
   * indices count its own file. Passing the parent through would make every raw fetch read the
   * wrong line and say nothing about it, so the affordance is removed rather than left to be
   * incidentally unreachable.
   */
  rawSource: "addressable" | "unaddressable";
  /** Tool-call keys whose body is open. */
  expandedTools: Set<string>;
  onToggleTool: (key: string) => void;
  pairedToolResults: ReadonlyMap<string, PairedToolResult>;
  /** Whether per-turn prompt-cache badges are rendered. */
  showCacheHits: boolean;
  /**
   * Branches this session from one of its messages, or absent where that cannot be offered.
   *
   * Absent rather than disabled on a surface that has nowhere to put a fork, and on sources that
   * cannot be forked at all: `--fork-session` is a Claude flag, and Codex would silently resume
   * into the original transcript instead of branching from it.
   */
  onForkFromMessage?: (message: { eventId: string; text: string }) => void;
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
function EventBody({
  ev,
  ctx,
  besideHeading,
  bareHeading,
}: {
  ev: ActivityEvent;
  ctx: EventRowContext;
  /**
   * Whether flowing text may sit beside the heading. Not on a tool row that names the call's
   * intent: thinking wrapped beside that ran straight into it.
   */
  besideHeading: boolean;
  /**
   * Whether the heading is only its chevron, so the first block sits beside it whatever it is. A
   * bordered block does that as its own formatting context, which narrows it past the chevron
   * rather than letting it run underneath.
   */
  bareHeading: boolean;
}) {
  const { inline, folded, hasRawJson } = partitionEventBlocks(ev);
  return (
    <div className="space-y-[0.4em]">
      {inline.map(({ block, index, images }, position) => (
        // Non-flow blocks are bordered boxes, which would sit UNDER the floated
        // heading rather than beside it. Clearing keeps them below it instead of
        // overlapping. Once content extends past the heading's height this is a
        // no-op, so later blocks are unaffected.
        //
        // Keyed by kind as well as position: one reveal position lives inside the
        // block, and a slot that changed kind would hand a reasoning trace the
        // cursor prose left behind, showing a prefix of it until the catch-up
        // caught up. The kind is stable in practice, so this remounts nothing.
        <div
          key={`${index}-${block.kind}`}
          className={
            besideHeading && isFlowBlock(block)
              ? undefined
              : bareHeading && position === 0 ? "flow-root" : "clear-left"
          }
        >
          <Block
            b={block}
            ctx={ctx}
            eventIndex={ev.index}
            blockIndex={index}
            eventType={ev.type}
            phase={ev.phase}
            resultImages={images}
          />
        </div>
      ))}
      <div className="clear-left">
        <RawDetails
          metadata={folded}
          session={ctx.session}
          rawSource={ctx.rawSource}
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
  const showRole = showEventRoleLabel(ctx.session.mode, role);
  // A heading with no chip and no intent has nothing for a block to run into: a tool row draws
  // none at all, and anywhere else it is a lone chevron the first block sits beside.
  const bareHeading = !showRole && !(role === "tool" && toolIntent(ev));
  return (
    <div className="flow-root">
      <EventHeading
        ev={ev}
        role={role}
        isCollapsed={isCollapsed}
        onToggle={onToggle}
        showCacheHits={ctx.showCacheHits}
        isLive={isLive}
        showRole={showRole}
      />
      {isCollapsed
        ? <CollapsedPreview ev={ev} />
        : (
          <EventBody
            ev={ev}
            ctx={ctx}
            besideHeading={role !== "tool" || bareHeading}
            bareHeading={bareHeading}
          />
        )}
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
  // Only where a person actually wrote the row. `displayRole` calls a tool result, a slash
  // command's echo and a `<system-reminder>` "user" as well, and offering to fork from one of
  // those would be offering a point the rewind picker does not have.
  const eventId = ev.id;
  const forkable = ctx.onForkFromMessage !== undefined
    && ev.humanTurn === true
    && eventId !== undefined;
  return (
    // Right-aligned, which is the one thing that separates what you said from what the session
    // said without reading either. The card shrinks to its text and stops at 85% of the row, so
    // the ragged left edge is the signal; a full-width card on the right would look the same as
    // every other row. Everything inside stays left-aligned -- prose, code and diffs are read
    // from a left margin whichever side of the feed they sit on.
    <div
      className={`${COLUMN_GUTTER_CLASS} flex items-start justify-end gap-1 py-[0.4em]`}
      style={{ fontSize: "var(--agent-panel-fs-tile-other-text, 16px)" }}
    >
      {/* Outside the card, on its left. The card is the one thing in this feed that is not
          full-width, so there is always room there -- and a menu inside it would either sit on top
          of the prose or push the card wider than what was said. */}
      {forkable ? (
        <RowMenu
          // Short on purpose: this becomes "Actions for ..." on a button that repeats down the
          // whole transcript, and a screen reader reading two hundred characters of prose to name
          // one of them is worse than no name at all.
          label={eventPreview(ev).slice(0, 60) || "this message"}
          items={[{
            label: "Fork from here",
            icon: GitBranch,
            onSelect: () => {
              if (eventId === undefined) return;
              ctx.onForkFromMessage?.({ eventId, text: messageText(ev) });
            },
          }]}
        />
      ) : null}
      <div
        className={
          // The highlight ring is INSET, on all three row kinds. It used to be drawn 4px outside
          // the card, and the band around it is now a scroll container (`ActivityFeedRow`), which
          // clips at its own padding box -- and a nice-mode row leaves that card 2px of vertical
          // room. An outward ring is offset first and coloured second, so clipping 2px removed
          // exactly the coloured half: the highlight would have survived on the left and right and
          // vanished top and bottom. Inside the card nothing can clip it.
          //
          // `min-w-0` so a wide child (a pasted diff, a long unbroken path) scrolls inside the
          // card the way it does anywhere else, rather than forcing the card past its maximum.
          "min-w-0 max-w-[85%] rounded-md border border-primary/30 bg-primary/10 px-[0.6em] py-[0.35em] transition-shadow duration-300 " +
          (isHighlighted ? "ring-2 ring-primary ring-inset" : "")
        }
      >
        <UserMessageBody ev={ev} ctx={ctx} isCollapsed={isCollapsed} onToggle={onToggle} />
      </div>
    </div>
  );
}

/**
 * Past this a message folds, and only then carries a chevron: most of what a person types is a line
 * or two, and a toggle on each was a control beside text with nothing to hide. Lines as well as
 * characters, because six one-word lines are as tall as a paragraph.
 */
function isFoldableUserMessage(ev: ActivityEvent): boolean {
  const text = ev.blocks.map((block) => (block.kind === "text" ? block.text ?? "" : "")).join("\n").trim();
  return text.length > 280 || text.split("\n").length > 6;
}

/**
 * What a person said, with no heading in front of it. A short message is only its text, whatever
 * the feed's collapse state says, since folding it would hide nothing. A long one ends in a
 * chevron: after the last line when open, after its one-line gist when folded, so the control sits
 * where the reader stops reading rather than ahead of the first word.
 */
function UserMessageBody({
  ev, ctx, isCollapsed, onToggle,
}: {
  ev: ActivityEvent;
  ctx: EventRowContext;
  isCollapsed: boolean;
  onToggle: () => void;
}) {
  if (!isFoldableUserMessage(ev)) {
    return <EventBody ev={ev} ctx={ctx} besideHeading bareHeading={false} />;
  }
  const when = ev.ts ? new Date(ev.ts).toLocaleTimeString() : undefined;
  const chevron = (
    <ChevronDown
      className={"size-[1em] shrink-0 text-muted-foreground transition-transform " + (isCollapsed ? "" : "rotate-180")}
      aria-hidden
    />
  );
  if (isCollapsed) {
    return (
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={false}
        aria-label="expand event"
        title={when}
        className="flex w-full min-w-0 items-center gap-[0.3em] rounded-sm text-left outline-none transition-colors hover:bg-foreground/5 focus-visible:ring-2 focus-visible:ring-primary"
      >
        <span className="min-w-0 flex-1"><CollapsedPreview ev={ev} /></span>
        {chevron}
      </button>
    );
  }
  return (
    <div>
      <EventBody ev={ev} ctx={ctx} besideHeading bareHeading={false} />
      <div className="flex justify-end">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded
          aria-label="collapse event"
          title={when}
          className="-mb-[0.1em] rounded-sm p-[0.1em] leading-none outline-none transition-colors hover:bg-foreground/5 focus-visible:ring-2 focus-visible:ring-primary"
        >
          {chevron}
        </button>
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
        ? "border-border session-view-row-tool "
        : "border-border/60 session-view-row ") +
      (isHighlighted ? "ring-2 ring-primary ring-inset " : "")
    : "border-x border-border session-view-row-tool px-[0.6em] transition-shadow duration-300 " +
      (isFirst ? "rounded-t-md border-t pt-[0.4em] " : "pt-[0.3em] ") +
      (isLast ? "rounded-b-md border-b pb-[0.4em] " : "pb-[0.3em] ") +
      (!isLast ? "border-b border-dashed border-border/60 " : "") +
      (isHighlighted ? "ring-2 ring-primary ring-inset " : "");
  const rowSpacing = isNice
    ? `${COLUMN_GUTTER_CLASS} py-[0.1em]`
    : COLUMN_GUTTER_CLASS + " " + (isFirst ? "pt-[0.4em] " : "") + (isLast ? "pb-[0.4em]" : "");
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
  const sameEventResults = pairSameEventToolResults(ev);
  const liveEvent = withoutPairedToolResults(ev, sameEventResults);
  const liveContext = sameEventResults.size === 0
    ? ctx
    : {
      ...ctx,
      pairedToolResults: new Map([...ctx.pairedToolResults, ...sameEventResults]),
    };
  return (
    <SegmentEventRow
      ev={liveEvent}
      ctx={liveContext}
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
    "border-x border-border session-view-row-tool px-[0.6em] " +
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
          <ChevronRight
            className="size-[1.1em] shrink-0 text-muted-foreground"
            aria-hidden
          />
          <span className="min-w-0 flex-1 truncate text-muted-foreground">
            {clusterLabel(events)}
          </span>
        </button>
      </div>
    </div>
  );
}
