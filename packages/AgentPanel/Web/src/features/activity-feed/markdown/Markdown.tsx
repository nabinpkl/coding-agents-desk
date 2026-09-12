"use client";

import { memo, useLayoutEffect, useMemo, useRef } from "react";
import "katex/dist/katex.min.css";
import "@/features/activity-feed/markdown/markdown.css";
import { CodeBlock } from "@/features/activity-feed/markdown/CodeBlock";
import { MermaidBlock } from "@/features/activity-feed/markdown/MermaidBlock";
import { applyProseHtml } from "@/features/activity-feed/markdown/patchProse";
import { createStreamingBlocks, toBlocks } from "@/features/activity-feed/markdown/proseBlocks";

// What each prose element was last given, so the patch can diff against the string
// we produced rather than the browser's reserialization of it. Keyed by the element
// so an entry dies with the node, and a reused node can never inherit another
// block's history.
const renderedHtml = new WeakMap<Element, string>();

/**
 * One sanitized prose run.
 *
 * Not `dangerouslySetInnerHTML`, because that rebuilds the whole run whenever the
 * string changes, and while a message streams the string changes thirty times a
 * second. `applyProseHtml` extends the trailing text node when that is all that
 * happened and replaces the run otherwise, so the steady state of a growing
 * paragraph is one `characterData` mutation per tick instead of a teardown.
 */
const ProseBlock = memo(function ProseBlock({ html }: { html: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    if (renderedHtml.get(el) === html) return;
    applyProseHtml(el, renderedHtml.get(el) ?? "", html);
    renderedHtml.set(el, html);
  }, [html]);
  return <div ref={ref} className="agent-panel-md__prose" />;
});

/**
 * Synchronous-first Markdown renderer for the activity feed.
 *
 * `streaming` says the document is still being written, which makes its LAST block
 * the only one that can still change -- and the only one worth treating differently.
 * A fenced block that has not closed yet lexes differently on every tick, so Shiki
 * recolours it as it grows and Mermaid re-runs its async layout; both flash. While
 * streaming, the tail fence renders unhighlighted and settles into its real form
 * once the message lands.
 */
export function Markdown({
  content,
  streaming = false,
  variant = "chat",
}: {
  content: string;
  streaming?: boolean;
  /**
   * Which register the prose is read in, and the only thing that separates the two surfaces
   * this renderer serves.
   *
   * `chat` is a run of prose inside a transcript row. A heading there marks a section of one
   * message rather than of a document, the column is whatever the row is, and the scale is
   * deliberately compressed -- see the ratios in `markdown.css`.
   *
   * `document` is a whole file somebody opened to READ: a README, a spec, an ADR. It gets a
   * measure, a document heading scale, and the vertical rhythm that goes with them. Passing it
   * costs the caller one word and changes nothing about how the Markdown is parsed.
   */
  variant?: "chat" | "document";
}) {
  // Alive only for as long as this message streams. The incremental reader earns its
  // state against a document being appended to; the moment the message lands the
  // whole-document path renders it, which is both the cheaper answer for a document
  // read once and the guarantee that a settled message shows nothing the incremental
  // reader decided. If React ever discards this memo mid-stream the reader simply
  // starts again -- the blocks are the same either way, only the work differs.
  const incremental = useMemo(() => (streaming ? createStreamingBlocks() : null), [streaming]);
  const blocks = useMemo(
    () => (incremental ? incremental(content) : toBlocks(content)),
    [incremental, content],
  );
  const surface = variant === "document"
    ? "agent-panel-md agent-panel-md--document"
    : "agent-panel-md";
  return (
    <div className={surface}>
      {blocks.map((b, i) => {
        const settled = !streaming || i < blocks.length - 1;
        if (b.kind === "code") {
          return <CodeBlock key={i} code={b.code} lang={b.lang} highlight={settled} />;
        }
        if (b.kind === "mermaid") {
          return settled ? (
            <MermaidBlock key={i} code={b.code} />
          ) : (
            <CodeBlock key={i} code={b.code} lang="mermaid" highlight={false} />
          );
        }
        return <ProseBlock key={i} html={b.html} />;
      })}
    </div>
  );
}
