"use client";

// One block of an event, rendered.
//
// Every kind an adapter can emit lands here: prose, reasoning, a tool call and the result
// folded into it, a plain labelled record. Raw blocks never do -- `partitionEventBlocks`
// routes those into the event's Raw drawer before this is reached.

import { ChevronRight } from "lucide-react";
import { DiffBlock } from "@/features/activity-feed/blocks/diff/DiffBlock";
import { describeEditChange } from "@/features/activity-feed/blocks/diff/describeEditChange";
import { SearchResultBody, parseSearchResult } from "@/features/activity-feed/blocks/SearchResultBody";
import { WebResultBody, parseWebResult } from "@/features/activity-feed/blocks/WebResultBody";
import { Markdown } from "@/features/activity-feed/markdown/Markdown";
import { CodeBlock } from "@/features/activity-feed/markdown/CodeBlock";
import { LabeledTextBlock, RawDetails } from "@/features/activity-feed/blocks/ActivitySystemBlocks";
import { EventFileImage, EventImageBlock } from "@/features/activity-feed/blocks/EventImageBlock";
import { ToolResultContent, stripReadLineNumbers } from "@/features/activity-feed/blocks/ToolResultViews";
import {
  SentFilesBlock,
  fileName,
  isPicture,
  sentFiles,
  withoutFileHandles,
} from "@/features/activity-feed/blocks/SentFilesBlock";
import { shellCommand } from "@/features/activity-feed/rows/activityEventText";
import type { SkillBody } from "@/features/activity-feed/rows/activityFeedLayout";
import { markdownSafePrefix, useProgressiveText } from "@/features/activity-feed/blocks/streamingText";
import type { ActivityBlock, ActivityEvent } from "@/features/activity-feed/useSessionEventsStream";
import type { EventRowContext } from "@/features/activity-feed/blocks/ActivityEventRows";

/** How many of a call's pictures ride its folded header before the rest wait for it to open. */
const HEADER_THUMBNAILS = 3;

// `.md` / `.mdx` file detection for tool calls whose body should render as
// formatted Markdown rather than raw source.
function isMarkdownPath(p: unknown): p is string {
  return typeof p === "string" && /\.mdx?$/i.test(p);
}

/** First non-empty string under any of these input keys, or null. */
function toolStringInput(
  input: Record<string, unknown> | undefined,
  keys: readonly string[],
): string | null {
  if (!input) return null;
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

/**
 * The instructions a skill loaded, drawn inside the call that loaded them.
 *
 * Markdown, because that is what a skill is written in: headings, lists and fenced code, which as
 * plain text is a wall of `#` and `-`. Bounded and scrolling for the reason the compaction
 * summary is -- these run to hundreds of lines, and a reader who opened one tool row should not
 * have to scroll past a document to reach the next.
 */
function SkillBodyBlock({ body, ctx }: { body: SkillBody; ctx: EventRowContext }) {
  return (
    <div className="space-y-1.5">
      <div
        className="max-h-[24em] overflow-y-auto overscroll-contain rounded-sm border border-border/50 bg-muted/30 px-2 py-1.5 leading-(--agent-panel-prose-leading) text-foreground"
        style={{ fontSize: "var(--agent-panel-fs-tile-other-text, 16px)" }}
      >
        <Markdown content={body.text} />
      </div>
      {/* Named apart from the call's own drawer and the result's, because this is a third
          transcript line that gave up its row to sit here. */}
      <RawDetails
        metadata={body.metadata}
        session={ctx.session}
        rawSource={ctx.rawSource}
        eventIndex={body.eventIndex}
        includesRawJson={body.includesRawEvent}
        label="Raw skill"
      />
    </div>
  );
}

export function Block({
  b, ctx, eventIndex, blockIndex, eventType, phase, resultImages = [],
}: {
  b: ActivityBlock;
  ctx: EventRowContext;
  eventIndex: number;
  blockIndex: number;
  eventType: ActivityEvent["type"];
  phase?: ActivityEvent["phase"];
  /** On a tool result: where the images it returned sit in this event. */
  resultImages?: number[];
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
    // File calls get a custom header (filename) and a body: an Edit draws its diff, while a
    // Write draws the file's contents. Generic tools get chip+summary as header. A matching
    // result expands inside this same block instead of consuming a second source-line row.
    //
    // Both harnesses' shapes: Claude's `Edit` carries snake_case (`file_path`,
    // `old_string`, `new_string`); opencode's `edit` carries camelCase (`path`,
    // `oldString`, `newString`). The header names the basename either way.
    const editPath = toolStringInput(b.input, ["file_path", "path"]);
    const editOld = toolStringInput(b.input, ["old_string", "oldString"]);
    const editNew = toolStringInput(b.input, ["new_string", "newString"]);
    const isEditDiff =
      (b.tool === "Edit" || b.tool === "edit") &&
      editPath !== null &&
      ((editOld !== null && editOld.length > 0) || (editNew !== null && editNew.length > 0));
    const writePath = toolStringInput(b.input, ["file_path", "path"]);
    const writeContent = toolStringInput(b.input, ["content"]);
    const isWrite = b.tool === "Write" || b.tool === "write";
    const isMarkdownWrite =
      isWrite && writePath !== null && isMarkdownPath(writePath) && writeContent !== null;
    const isCodeWrite =
      isWrite && writePath !== null && !isMarkdownPath(writePath) && writeContent !== null;
    const isFileBody = isEditDiff || isMarkdownWrite || isCodeWrite;
    const fileBodyPath = isEditDiff ? editPath : isFileBody ? writePath : null;
    // A file the call READ, drawn as source once its result lands: the paired result's preview
    // is the file's content (Claude prefixes `cat -n` line numbers, stripped here), highlighted
    // by the path's own grammar. Markdown reads render as prose, the way markdown writes do.
    // Empty previews stay on the existing path: a `Read screenshot.png` returned only a picture,
    // and an empty code block above it would be the one false thing in the row.
    const readPath = toolStringInput(b.input, ["file_path", "path"]);
    const isReadCall = b.tool === "Read" || b.tool === "read";
    const readText = pairedResult?.block.preview?.trim() ? pairedResult.block.preview : null;
    const isMarkdownRead =
      isReadCall && readPath !== null && isMarkdownPath(readPath) && readText !== null;
    const isCodeRead =
      isReadCall && readPath !== null && !isMarkdownPath(readPath) && readText !== null;
    // A search the call drew structured above: content matches grouped by file, file lists as
    // rows. Parsed off the same result text; null stays on the generic `pre` below.
    const searchBody = parseSearchResult(b.tool, readText ?? "");
    // A web fetch or search, whose result is Markdown by the tool's own contract. Named by tool,
    // never sniffed: see `WebResultBody`.
    const webBody = parseWebResult(b.tool, readText ?? "");
    // The header truncates the command to one line. Expanding shows it as a
    // shell code block, which highlights it and scrolls horizontally rather
    // than cutting it off at the row's width.
    const command = shellCommand(b);
    // A call whose result already carried its picture draws it there, full size, so the files it
    // named are not drawn a second time above it. `Read screenshot.png` is that case.
    const namedFiles = pairedResult?.images.length ? null : sentFiles(b);
    const caption = typeof b.input?.caption === "string" ? b.input.caption.trim() : "";
    const hasBody =
      isFileBody || command !== null || pairedResult !== undefined || namedFiles !== null;
    // Opencode's lowercase `edit` chips as Edit: the case is a harness
    // accent, not a different tool, and `edit edit` reads as a stutter.
    const headerChip = isEditDiff || b.tool === "edit" ? "Edit" : b.tool;
    // The summary is written to stand alone -- a folded row and the sticky bar show it with no
    // chip beside it -- so on this line, which draws the chip, it repeats the tool's name back:
    // `SendUserFile  SendUserFile aim-deep.png`. Said once.
    const summary = b.summary ?? "";
    const named = headerChip && summary.startsWith(`${headerChip} `)
      ? summary.slice(headerChip.length + 1)
      : summary;
    const headerLabel = fileBodyPath !== null
      ? (fileBodyPath.split("/").pop() ?? "")
      : named;
    // A call that returned a picture shows it while folded, since that picture is usually why the
    // call was made. Open, the result draws it full size, so the header's copy steps aside.
    const headerImages = !isExpanded && pairedResult ? pairedResult.images : [];
    // The same for a call that HANDED pictures over, which is the other way one reaches a row.
    // Capped, because these come in sets and each one is `shrink-0`: past a few, the thumbnails
    // would take the width the call's own name is truncating in.
    const headerFiles = !isExpanded && namedFiles
      ? namedFiles.map((path, fileIndex) => ({ path, fileIndex }))
        .filter(({ path }) => isPicture(path))
        .slice(0, HEADER_THUMBNAILS)
      : [];
    // What the edit changed, on its own row under the header: the header
    // keeps naming the file, this names the change. Null stays off the row.
    const editDetail = isEditDiff
      ? describeEditChange(editOld ?? "", editNew ?? "", editPath ?? undefined)
      : null;
    return (
      <div className="space-y-1.5">
        <div
          className="flex items-center gap-1.5"
          style={{ fontSize: "var(--agent-panel-fs-tile-other-text, 16px)" }}
        >
          <button
            type="button"
            onClick={() => hasBody && ctx.onToggleTool(toolKey)}
            aria-expanded={isExpanded}
            disabled={!hasBody}
            className={
              "flex min-w-0 flex-1 items-baseline gap-1.5 rounded-sm font-mono text-left transition-colors " +
              (hasBody ? "hover:bg-foreground/5 " : "cursor-default ")
            }
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
          {/* Beside the header rather than inside it: a button cannot hold another button. */}
          {pairedResult
            ? headerImages.map((blockIndex) => (
                <EventImageBlock
                  key={blockIndex}
                  ctx={ctx}
                  eventIndex={pairedResult.eventIndex}
                  blockIndex={blockIndex}
                  alt="Image this tool returned"
                  compact
                />
              ))
            : null}
          {headerFiles.map(({ path, fileIndex }) => (
            <EventFileImage
              key={fileIndex}
              ctx={ctx}
              eventIndex={eventIndex}
              blockIndex={blockIndex}
              fileIndex={fileIndex}
              name={fileName(path)}
              compact
            />
          ))}
        </div>
        {editDetail ? (
          <div
            className="truncate font-mono text-muted-foreground"
            style={{ fontSize: "var(--agent-panel-fs-tile-chip, 12px)" }}
          >
            {editDetail}
          </div>
        ) : null}
        {isExpanded ? (
          <>
            {/* The header truncates the summary to the row's width; expanded,
                the full line reads here above the command it names. Shell rows
                only: other calls already draw their full content below. */}
            {command !== null && summary ? (
              <div className="text-muted-foreground">{summary}</div>
            ) : null}
            {/* Wrapped: this is one command, not source, so it has no indentation to read and
                nothing is gained by putting the rest of it behind a horizontal scroll. */}
            {command !== null ? <CodeBlock code={command} lang="bash" wrap /> : null}
            {isEditDiff ? (
              <DiffBlock
                filePath={editPath!}
                oldString={editOld ?? ""}
                newString={editNew ?? ""}
              />
            ) : null}
            {isMarkdownWrite ? (
              <Markdown content={writeContent!} />
            ) : null}
            {isCodeWrite ? (
              <CodeBlock code={writeContent!} lang={writePath!} />
            ) : null}
            {isMarkdownRead ? (
              <Markdown content={stripReadLineNumbers(readText!)} />
            ) : null}
            {isCodeRead ? (
              <CodeBlock code={stripReadLineNumbers(readText!)} lang={readPath!} />
            ) : null}
            {searchBody ? <SearchResultBody body={searchBody} /> : null}
            {webBody ? <WebResultBody body={webBody} /> : null}
            {namedFiles ? (
              <SentFilesBlock
                files={namedFiles}
                caption={caption || undefined}
                ctx={ctx}
                eventIndex={eventIndex}
                blockIndex={blockIndex}
              />
            ) : null}
            {pairedResult ? (
              <ToolResultContent
                result={pairedResult}
                ctx={ctx}
                text={
                  // A skill's result says only `Launching skill: <name>`, and the chip and label
                  // on this very row already say which skill. With the body under it, drawing
                  // that line is the row repeating itself; empty leaves the result's own Raw
                  // drawer, which is the part that would otherwise become unreachable. A read
                  // or search the call drew structured above is the same: the text lives in the
                  // body, not twice.
                  pairedResult.skillBody || isMarkdownRead || isCodeRead || searchBody !== null || webBody !== null
                    ? ""
                    : namedFiles
                      ? withoutFileHandles(pairedResult.block.preview)
                      : undefined
                }
              />
            ) : null}
            {pairedResult?.skillBody ? (
              <SkillBodyBlock body={pairedResult.skillBody} ctx={ctx} />
            ) : null}
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
          images: resultImages,
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
  if (b.kind === "image") {
    return <EventImageBlock ctx={ctx} eventIndex={eventIndex} blockIndex={blockIndex} />;
  }
  // Raw blocks never reach here: partitionEventBlocks routes every one of them
  // into the event's Raw drawer. Compaction blocks render as a full-row banner
  // via CompactionRow, not inline. Returning null keeps both paths silent.
  return null;
}
