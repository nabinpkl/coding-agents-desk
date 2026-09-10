"use client";

// One block of an event, rendered.
//
// Every kind an adapter can emit lands here: prose, reasoning, a tool call and the result
// folded into it, a plain labelled record. Raw blocks never do -- `partitionEventBlocks`
// routes those into the event's Raw drawer before this is reached.

import { ChevronRight } from "lucide-react";
import { DiffBlock } from "@/features/activity-feed/blocks/DiffBlock";
import { Markdown } from "@/features/activity-feed/markdown/Markdown";
import { CodeBlock } from "@/features/activity-feed/markdown/CodeBlock";
import { LabeledTextBlock, RawDetails } from "@/features/activity-feed/blocks/ActivitySystemBlocks";
import { shellCommand } from "@/features/activity-feed/rows/activityEventText";
import type { PairedToolResult } from "@/features/activity-feed/rows/activityFeedLayout";
import { markdownSafePrefix, useProgressiveText } from "@/features/activity-feed/blocks/streamingText";
import type { ActivityBlock, ActivityEvent } from "@/features/activity-feed/useSessionEventsStream";
import type { EventRowContext } from "@/features/activity-feed/blocks/ActivityEventRows";

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

export function Block({
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
