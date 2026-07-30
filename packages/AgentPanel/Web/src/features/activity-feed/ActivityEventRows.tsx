"use client";

import { ChevronRight } from "lucide-react";
import { DiffBlock } from "./DiffBlock";
import { Markdown } from "./markdown/Markdown";
import { CodeBlock } from "./markdown/CodeBlock";
import { LabeledTextBlock, RawDetails } from "./ActivitySystemBlocks";
import {
  displayRole,
  eventPreview,
  isFlowBlock,
  partitionEventBlocks,
  shellCommand,
  type DisplayRole,
  type PairedToolResult,
} from "./activityDisplayItems";
import type { ActivityBlock, ActivityEvent } from "./useSessionEventsStream";
import type { AgentSource } from "./data-source/AgentDataSource";

/** What every row and block needs from the feed, bundled to stop prop drift. */
export interface EventRowContext {
  source: AgentSource;
  sessionId: string;
  /** Tool-call keys whose body is open. */
  expandedTools: Set<string>;
  onToggleTool: (key: string) => void;
  pairedToolResults: ReadonlyMap<string, PairedToolResult>;
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

// `leading-none` is load-bearing, not cosmetic. The heading floats, and a float
// taller than one line of body text overlaps the SECOND line too, indenting it
// as well -- at 14px/1.375 the line is 20.3px, and the chip's default leading
// pushed the float to 23px, so a two-line paragraph came out fully indented and
// gave back the width this heading was meant to save.
const CHIP_CLASS =
  "rounded-sm px-[0.4em] py-[0.15em] font-mono text-(length:--agent-panel-fs-tile-chip,12px) font-bold uppercase leading-none tracking-wider ";

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
}: {
  ev: ActivityEvent;
  role: DisplayRole;
  isCollapsed: boolean;
  onToggle: () => void;
}) {
  const when = ev.ts ? new Date(ev.ts).toLocaleTimeString() : null;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={!isCollapsed}
      aria-label={isCollapsed ? "expand event" : "collapse event"}
      title={when ? `#${ev.index} · ${when}` : `#${ev.index}`}
      className="float-left mt-[0.15em] mr-[0.4em] flex items-center gap-[0.2em] rounded-sm text-left transition-colors hover:bg-foreground/5"
    >
      <ChevronRight
        className={
          "size-[1em] shrink-0 text-muted-foreground transition-transform " +
          (isCollapsed ? "" : "rotate-90")
        }
        aria-hidden
      />
      <span className={CHIP_CLASS + ROLE_STYLES[role]}>{role}</span>
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
        <div key={index} className={isFlowBlock(block) ? undefined : "clear-left"}>
          <Block
            b={block}
            ctx={ctx}
            eventIndex={ev.index}
            blockIndex={index}
            eventType={ev.type}
          />
        </div>
      ))}
      <div className="clear-left">
        <RawDetails
          metadata={folded}
          source={ctx.source}
          sessionId={ctx.sessionId}
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
}: {
  ev: ActivityEvent;
  role: DisplayRole;
  isCollapsed: boolean;
  onToggle: () => void;
  ctx: EventRowContext;
}) {
  return (
    <div className="flow-root">
      <EventHeading ev={ev} role={role} isCollapsed={isCollapsed} onToggle={onToggle} />
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
    <div
      className="px-[0.55em] py-[0.4em]"
      style={{ fontSize: "var(--agent-panel-fs-tile-other-text, 14px)" }}
    >
      <div
        className={
          "rounded-md border border-primary/30 bg-primary/10 px-[0.6em] py-[0.35em] transition-shadow duration-300 " +
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
  ev, ctx, isFirst, isLast, isCollapsed, onToggle, isHighlighted,
}: {
  ev: ActivityEvent;
  ctx: EventRowContext;
  isFirst: boolean;
  isLast: boolean;
  isCollapsed: boolean;
  onToggle: () => void;
  isHighlighted: boolean;
}) {
  const role = displayRole(ev);
  const wrapperClass =
    "border-x border-border bg-muted/60 px-[0.6em] transition-shadow duration-300 " +
    (isFirst ? "rounded-t-md border-t pt-[0.4em] " : "pt-[0.3em] ") +
    (isLast ? "rounded-b-md border-b pb-[0.4em] " : "pb-[0.3em] ") +
    (!isLast ? "border-b border-dashed border-border/60 " : "") +
    (isHighlighted ? "ring-2 ring-primary ring-offset-2 ring-offset-background " : "");
  return (
    <div
      className={"px-[0.55em] " + (isFirst ? "pt-[0.4em] " : "") + (isLast ? "pb-[0.4em]" : "")}
      style={{ fontSize: "var(--agent-panel-fs-tile-other-text, 14px)" }}
    >
      <div className={wrapperClass}>
        <EventRowShell
          ev={ev}
          role={role}
          isCollapsed={isCollapsed}
          onToggle={onToggle}
          ctx={ctx}
        />
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
        source={ctx.source}
        sessionId={ctx.sessionId}
        eventIndex={result.eventIndex}
        includesRawJson={result.includesRawEvent}
        label="Raw result"
      />
    </div>
  );
}

function Block({
  b, ctx, eventIndex, blockIndex, eventType,
}: {
  b: ActivityBlock;
  ctx: EventRowContext;
  eventIndex: number;
  blockIndex: number;
  eventType: ActivityEvent["type"];
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
          <span className="shrink-0 rounded-sm bg-muted px-1 py-0.5 text-(length:--agent-panel-fs-tile-chip,12px) font-semibold text-foreground/80">
            {headerChip}
          </span>
          <span className="min-w-0 flex-1 truncate text-foreground/80">
            {headerLabel}
          </span>
        </button>
        {isExpanded ? (
          <>
            {command !== null ? <CodeBlock code={command} lang="bash" /> : null}
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
        className="italic leading-snug text-foreground/65"
        style={{ fontSize: "var(--agent-panel-fs-tile-reasoning, 13px)" }}
      >
        <Markdown content={b.text} />
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
      className="px-[0.55em] py-[0.5em]"
      style={{ fontSize: "var(--agent-panel-fs-tile-other-text, 14px)" }}
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
          source={ctx.source}
          sessionId={ctx.sessionId}
          eventIndex={ev.index}
          includesRawJson={hasRawJson}
        />
      </div>
    </div>
  );
}
