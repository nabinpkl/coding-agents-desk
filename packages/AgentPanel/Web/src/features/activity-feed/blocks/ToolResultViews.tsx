"use client";

// The result half of a paired tool call, drawn inside the call's own block.
//
// The call owns the header and the body; this owns everything the result
// contributes: its text preview (or the "(empty result)" label when there is
// nothing to show and no picture to say so instead), the pictures it
// returned, and its own Raw drawer beside the call's.

import { Markdown } from "@/features/activity-feed/markdown/Markdown";
import { LabeledTextBlock, RawDetails } from "@/features/activity-feed/blocks/ActivitySystemBlocks";
import { EventImageBlock } from "@/features/activity-feed/blocks/EventImageBlock";
import type { PairedToolResult } from "@/features/activity-feed/rows/activityFeedLayout";
import type { ActivityBlock } from "@/features/activity-feed/useSessionEventsStream";
import type { EventRowContext } from "@/features/activity-feed/blocks/ActivityEventRows";

function ToolResultBlock({
  block,
  renderMarkdown,
  text,
}: {
  block: ActivityBlock;
  renderMarkdown?: boolean;
  /** What to show instead of the result's own preview, where the call renders the rest itself. */
  text?: string;
}) {
  const showing = text ?? block.preview ?? "";

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

// Claude `Read` results are `cat -n` output: every line is prefixed with
// optional leading spaces, the line number, then a tab. Strip that prefix to
// recover the source Markdown. (Repo convention documents the "line number +
// tab" shape.) Non-prefixed lines pass through untouched.
export function stripReadLineNumbers(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/^\s*\d+\t/, ""))
    .join("\n");
}

export function ToolResultContent({
  result,
  ctx,
  text,
}: {
  result: PairedToolResult;
  ctx: EventRowContext;
  /** What the result says, where the call has already drawn the rest of it. */
  text?: string;
}) {
  const hasImages = result.images.length > 0;
  const showing = text ?? result.block.preview;
  // A result that returned only a picture is not empty, and saying so above the picture would be
  // the one false thing in the row.
  // Nor would "(empty result)" be true of a call that drew the result itself and left nothing over.
  const content = showing ? (
    <ToolResultBlock block={result.block} text={showing} />
  ) : hasImages || text !== undefined ? null : (
    <LabeledTextBlock
      block={{ ...result.block, kind: "plain", label: "Tool Result", text: "(empty result)" }}
    />
  );

  return (
    <div className="space-y-1.5">
      {content}
      {hasImages ? (
        <div className="flex flex-wrap gap-2">
          {result.images.map((blockIndex) => (
            <EventImageBlock
              key={blockIndex}
              ctx={ctx}
              eventIndex={result.eventIndex}
              blockIndex={blockIndex}
              alt="Image this tool returned"
            />
          ))}
        </div>
      ) : null}
      {/* Named apart from the call's own drawer: this one is the result's
          source line, which sits in the same row once the two are paired. */}
      <RawDetails
        metadata={result.metadata}
        session={ctx.session}
        rawSource={ctx.rawSource}
        eventIndex={result.eventIndex}
        includesRawJson={result.includesRawEvent}
        label="Raw result"
      />
    </div>
  );
}
