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
import { markdownSafePrefix, useProgressiveText } from "./streamingText";

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
 * The per-turn prompt-cache badge: the actual cached and total input token
 * counts, e.g. `cached 13,184 / 31,428`, next to the row the turn's usage
 * belongs to. The hit fraction rides in the tooltip and accessible label.
 * Rendered only while the cache-hits toggle is on.
 */
export function CacheBadge({ cacheHit }: { cacheHit: EventCacheHit }) {
  const fraction = cacheHit.input > 0 ? cacheHit.cached / cacheHit.input : 0;
  const percent = Math.min(100, Math.max(0, Math.round(fraction * 100)));
  return (
    <span
      title={`${cacheHit.cached.toLocaleString()} of ${cacheHit.input.toLocaleString()} input tokens served from the prompt cache (${percent}%)`}
      aria-label={`Prompt cache: ${cacheHit.cached.toLocaleString()} of ${cacheHit.input.toLocaleString()} input tokens`}
      className="ml-[0.5em] shrink-0 rounded-sm bg-emerald-500/15 px-[0.35em] py-[0.1em] font-mono text-(length:--agent-panel-fs-tile-chip,12px) leading-none tabular-nums text-emerald-600 dark:text-emerald-400"
    >
      cached {cacheHit.cached.toLocaleString()} / {cacheHit.input.toLocaleString()}
    </span>
  );
}

export const ROLE_STYLES: Record<DisplayRole, string> = {
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
export const ROLE_BORDER: Record<DisplayRole, string> = {
  user: "border-l-primary",
  assistant: "border-l-muted-foreground/50",
  tool: "border-l-amber-500",
  result: "border-l-foreground/40",
  reasoning: "border-l-violet-500",
  system: "border-l-sky-500",
};

/** Nice keeps operational roles, but lets model prose and reasoning read as one response. */
export function showEventRoleLabel(
  mode: SessionReference["mode"],
  role: DisplayRole,
): boolean {
  return mode === "raw" || (role !== "assistant" && role !== "reasoning");
}

// `leading-none` is load-bearing, not cosmetic. The heading floats, and a float
// taller than one line of body text overlaps the SECOND line too, indenting it
// as well -- at the 16px/1.375 body the line is 22px, and the chip's default
// leading pushed the float past it, so a two-line paragraph came out fully
// indented and gave back the width this heading was meant to save.
//
// The chip is its own token (`tile_chip`, 12px) and does not scale with the
// body, so the clearance is whatever `tile_other_text` is minus a constant.
// Raising the body default to 16 widened it; the 10px floor is the narrow end
// and is where to look first if the chip's leading or padding ever changes.
const CHIP_CLASS =
  "rounded-sm px-[0.4em] py-[0.15em] font-mono text-(length:--agent-panel-fs-tile-chip,12px) font-bold uppercase leading-none tracking-wider ";
const FEED_ROW_GUTTER_CLASS = "px-6";

/**
 * An event's role chip and collapse toggle, floated so the first line of the
 * body sits beside it.
 *
 * This used to be a full-width bar above the body, which cost every event a
 * ~30px row carrying no content. Floating recovers that row for events whose
 * body starts with prose; bordered blocks clear the float (see
 * `isFlowBlock`) and so still begin below it.
 *
 * The event index and timestamp moved into `title` and the Raw drawer. They
 * were spending permanent width on two values nobody scans by eye, and the
 * drawer already holds every other per-event fact.
 */
function EventHeading({
  ev,
  role,
  isCollapsed,
  onToggle,
  showCacheHits,
  isLive,
  showRole,
}: {
  ev: ActivityEvent;
  role: DisplayRole;
  isCollapsed: boolean;
  onToggle: () => void;
  showCacheHits: boolean;
  isLive: boolean;
  showRole: boolean;
}) {
  const when = ev.ts ? new Date(ev.ts).toLocaleTimeString() : null;
  const intent = role === "tool" ? toolIntent(ev) : null;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={!isCollapsed}
      // The live state rides the label rather than a visible band, so it is
      // announced without spending a line. The pulse below is its sighted twin.
      aria-label={
        (isCollapsed ? "expand event" : "collapse event") + (isLive ? ", streaming" : "")
      }
      // A live row has no transcript position yet, so it says what it is instead
      // of naming an index that would read as `#-1`.
      title={isLive ? "streaming" : when ? `#${ev.index} · ${when}` : `#${ev.index}`}
      // `max-w-full` is what keeps a phone from scrolling sideways. A float is sized shrink-to-fit,
      // which floors at its min-content width, and the intent span below caps itself in `ch` --
      // an absolute bound that a 390px column cannot afford, so the float grew past the viewport
      // and took the whole transcript's horizontal scroll with it. Measured at 466px of content in
      // a 390px scroller; capped, 390.
      className="float-left mt-[0.15em] mr-[0.4em] flex max-w-full items-center gap-[0.2em] rounded-sm text-left transition-colors hover:bg-foreground/5"
    >
      <ChevronRight
        className={
          "size-[1em] shrink-0 text-muted-foreground transition-transform " +
          (isCollapsed ? "" : "rotate-90")
        }
        aria-hidden
      />
      {showRole ? <span className={CHIP_CLASS + ROLE_STYLES[role]}>{role}</span> : null}
      {/* The ONLY thing a still-streaming row shows that a landed one does not.
          Inline and sub-chip sized, so when the transcript takes the message over
          and the dot goes away, one line loses a few pixels of width and nothing
          moves vertically. */}
      {isLive ? (
        <span
          className="ml-[0.15em] inline-block size-[0.45em] shrink-0 animate-pulse rounded-full bg-primary"
          aria-hidden
        />
      ) : null}
      {showCacheHits && ev.cacheHit ? <CacheBadge cacheHit={ev.cacheHit} /> : null}
      {/* Why the tool ran, beside the chip that says a tool ran. Only when expanded: a collapsed
          row already spends this space on its gist, and the heading is otherwise blank here. */}
      {!isCollapsed && intent ? (
        // Bounded, because this sits inside a float-left heading: an unbounded span would grow
        // the float to the width of a long description and push the body around it.
        <span className="ml-[0.35em] max-w-[36ch] truncate font-sans text-muted-foreground">
          {intent}
        </span>
      ) : null}
    </button>
  );
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
      style={{ fontSize: "var(--agent-panel-fs-tile-other-text, 16px)" }}
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
  ctx,
}: {
  result: PairedToolResult;
  ctx: EventRowContext;
}) {
  const content = result.block.preview ? (
    <ToolResultBlock block={result.block} />
  ) : (
    <LabeledTextBlock
      block={{ ...result.block, kind: "plain", label: "Tool Result", text: "(empty result)" }}
    />
  );

  return (
    <div className="space-y-1.5">
      {content}
      {/* Named apart from the call's own drawer: this one is the result's
          source line, which sits in the same row once the two are paired. */}
      <RawDetails
        metadata={result.metadata}
        session={ctx.session}
        eventIndex={result.eventIndex}
        includesRawJson={result.includesRawEvent}
        label="Raw result"
      />
    </div>
  );
}

function Block({
  b, ctx, eventIndex, blockIndex, eventType, phase,
}: {
  b: ActivityBlock;
  ctx: EventRowContext;
  eventIndex: number;
  blockIndex: number;
  eventType: ActivityEvent["type"];
  phase?: ActivityEvent["phase"];
}) {
  // Call the hook unconditionally so a stream of revisions keeps one reveal
  // position: the model's own prose reveals progressively while streaming, and
  // anything else snaps to full text.
  //
  // Reasoning reveals on the same terms as prose. It is the thinnest text on the
  // row on purpose, but a trace that lands in phrase-sized jumps reads as a
  // glitch rather than as de-emphasis -- and on a thinking-heavy turn it is most
  // of what is on screen, so it was the jumping half of a row whose other half
  // typed. User text and tool payloads are excluded: they are not being written
  // as we watch, and revealing them would animate a paste.
  const isModelProse =
    b.kind === "reasoning" || (b.kind === "text" && eventType === "assistant");
  const isStreamingProse = isModelProse && phase === "streaming";
  const revealed = useProgressiveText(isModelProse ? (b.text ?? "") : "", isStreamingProse);
  // Held back to a boundary that renders, so a cut inside `**` never shows its own
  // markup on the way past. Only while streaming: a finished message with an
  // unmatched marker renders exactly as the model wrote it.
  const revealedText = isStreamingProse ? markdownSafePrefix(revealed) : revealed;
  if (b.kind === "text") {
    // Assistant text is the model's prose response; it conventionally
    // contains markdown (headings, code fences, lists, tables) that should
    // render rather than show as raw source. User text and tool textual
    // payloads stay plain so escaping characters survive.
    //
    // Rendered as Markdown WHILE STREAMING too, which costs something real: a
    // paragraph break is invisible until the second newline of its `\n\n` lands,
    // so two paragraphs read joined for about one token. The live tail used to
    // render pre-wrapped source to avoid exactly that -- and paid for it at the
    // handoff, where the whole message re-rendered as Markdown under the reader.
    // A one-token joined break beats a full reflow of the paragraph being read.
    if (eventType === "assistant" && b.text) {
      return (
<div
          className="leading-(--agent-panel-prose-leading) text-foreground"
          style={{ fontSize: "var(--agent-panel-fs-tile-other-text, 16px)" }}
        >
          <Markdown content={revealedText} streaming={isStreamingProse} />
        </div>
      );
    }
    return (
      <div
        className="whitespace-pre-wrap break-words leading-(--agent-panel-prose-leading) text-foreground"
        style={{ fontSize: "var(--agent-panel-fs-tile-other-text, 16px)" }}
      >
        {b.text}
      </div>
    );
  }
  if (b.kind === "tool_use") {
    const toolKey = b.callId ?? `${eventIndex}-${blockIndex}`;
    const pairedResult = b.callId ? ctx.pairedToolResults.get(b.callId) : undefined;
    const isExpanded = ctx.expandedTools.has(toolKey);
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
    // The header truncates the command to one line. Expanding shows it as a
    // shell code block, which highlights it and scrolls horizontally rather
    // than cutting it off at the row's width.
    const command = shellCommand(b);
    const hasBody = isFileBody || command !== null || pairedResult !== undefined;
    const headerLabel = isFileBody
      ? (typeof b.input?.file_path === "string" ? b.input.file_path.split("/").pop() ?? "" : "")
      : (b.summary || "");
    const headerChip = isEditDiff ? "Edit" : b.tool;
    return (
      <div className="space-y-1.5">
        <button
          type="button"
          onClick={() => hasBody && ctx.onToggleTool(toolKey)}
          aria-expanded={isExpanded}
          disabled={!hasBody}
          className={
            "flex w-full items-baseline gap-1.5 rounded-sm font-mono text-left transition-colors " +
            (hasBody ? "hover:bg-foreground/5 " : "cursor-default ")
          }
          style={{ fontSize: "var(--agent-panel-fs-tile-other-text, 16px)" }}
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
          <span className="shrink-0 rounded-sm bg-muted px-1 py-0.5 text-(length:--agent-panel-fs-tile-chip,12px) font-semibold text-foreground/80">
            {headerChip}
          </span>
          <span className="min-w-0 flex-1 truncate text-foreground/80">
            {headerLabel}
          </span>
        </button>
        {isExpanded ? (
          <>
            {/* Wrapped: this is one command, not source, so it has no indentation to read and
                nothing is gained by putting the rest of it behind a horizontal scroll. */}
            {command !== null ? <CodeBlock code={command} lang="bash" wrap /> : null}
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
            {pairedResult ? <ToolResultContent result={pairedResult} ctx={ctx} /> : null}
          </>
        ) : null}
      </div>
    );
  }
  if (b.kind === "tool_result") {
    return (
      <ToolResultContent
        // An unpaired result renders inside its own event row, whose EventBody
        // already owns that event's Raw drawer.
        result={{
          block: b,
          eventIndex,
          blockIndex,
          includesRawEvent: false,
          metadata: [],
        }}
        ctx={ctx}
      />
    );
  }
  if (b.kind === "reasoning") {
    if (!b.text) return null;
    // Reasoning arrives as Markdown -- thinking blocks routinely open with a
    // bolded topic line -- and rendering it as plain text put literal `**`
    // asterisks on screen. Italic on the wrapper cascades into the rendered
    // prose, so the trace still reads as commentary rather than headline.
    return (
      <div
        className="italic leading-(--agent-panel-prose-leading) text-foreground/65"
        style={{
          fontSize: "var(--agent-panel-fs-tile-reasoning, 14px)",
          // Italic, a size step down, and 65% opacity: the thinnest text here,
          // and it is where the trace's own prose lives. Inter's weight axis
          // is continuous, so 450 buys back the stroke the italic gives up.
          // The bolded topic line stays distinct: the UA's `bolder` on
          // <strong> maps any inherited weight in 400-499 to the same 700.
          fontWeight: 450,
        }}
      >
        <Markdown content={revealedText} streaming={isStreamingProse} />
      </div>
    );
  }
  if (b.kind === "metadata" || b.kind === "plain") {
    return <LabeledTextBlock block={b} />;
  }
  // Raw blocks never reach here: partitionEventBlocks routes every one of them
  // into the event's Raw drawer. Compaction blocks render as a full-row banner
  // via CompactionRow, not inline. Returning null keeps both paths silent.
  return null;
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
