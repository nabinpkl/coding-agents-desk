"use client";

import { memo, useContext, useMemo, useRef, useState, type SyntheticEvent } from "react";
import { createPortal } from "react-dom";
import "katex/dist/katex.min.css";
import "@/features/activity-feed/markdown/markdown.css";
import { CodeBlock } from "@/features/activity-feed/markdown/CodeBlock";
import { MermaidBlock } from "@/features/activity-feed/markdown/MermaidBlock";
import {
  filePathAt,
  FilePathOpenerContext,
  linkFilePaths,
} from "@/features/activity-feed/markdown/filePathLinks";
import { applyProseHtml } from "@/features/activity-feed/markdown/patchProse";
import {
  createStreamingBlocks,
  FENCE_SLOT_ATTRIBUTE,
  toBlocks,
  type FenceBlock,
} from "@/features/activity-feed/markdown/proseBlocks";
import { useDomSync } from "@/hooks/dom/useDomSync";

// What each prose element was last given, so the patch can diff against the string
// we produced rather than the browser's reserialization of it. Keyed by the element
// so an entry dies with the node, and a reused node can never inherit another
// block's history.
const renderedHtml = new WeakMap<Element, string>();
// Prose `linkFilePaths` marked. Its DOM no longer matches the string it was given -- text nodes may
// have been split into spans -- so the next change replaces it rather than extending a text node
// that moved.
const restructured = new WeakSet<Element>();

/**
 * One sanitized prose run.
 *
 * Not `dangerouslySetInnerHTML`, because that rebuilds the whole run whenever the
 * string changes, and while a message streams the string changes thirty times a
 * second. `applyProseHtml` extends the trailing text node when that is all that
 * happened and replaces the run otherwise, so the steady state of a growing
 * paragraph is one `characterData` mutation per tick instead of a teardown.
 */
const ProseBlock = memo(function ProseBlock({
  html,
  fences,
  settled,
}: {
  html: string;
  fences: readonly FenceBlock[];
  settled: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // The empty divs `peelNestedFences` left in the HTML, which the fences below are mounted into.
  // Held in state rather than read during render because they do not exist until this element has
  // its HTML: the DOM sync below writes the HTML and then hands the nodes back, and running before
  // paint is what keeps that second pass inside the same frame, so a fence never flashes at zero
  // height in a feed that measures its rows.
  const [slots, setSlots] = useState<readonly Element[]>([]);
  const opener = useContext(FilePathOpenerContext);
  const root = opener?.root ?? null;
  useDomSync(() => {
    const el = ref.current;
    if (el === null) return;
    // Marked paths whose opener has gone are links to nowhere, so they go with it.
    const stale = root === null && restructured.has(el);
    if (renderedHtml.get(el) !== html || stale) {
      applyProseHtml(el, restructured.has(el) ? "" : renderedHtml.get(el) ?? "", html);
      restructured.delete(el);
      renderedHtml.set(el, html);
    }
    // Only once the block has settled: a streaming block is patched in place on every tick, and a
    // path still being typed is not yet the path it will be.
    if (root !== null && settled && linkFilePaths(el, root)) restructured.add(el);
    const found = [...el.querySelectorAll(`[${FENCE_SLOT_ATTRIBUTE}]`)];
    setSlots((current) => (
      current.length === found.length && current.every((node, at) => node === found[at])
        ? current
        : found
    ));
  }, [html, root, settled]);
  const openPath = (event: SyntheticEvent<HTMLDivElement>): void => {
    if (opener === null) return;
    const target = filePathAt(event.target, event.currentTarget);
    if (target === null) return;
    // A drag that selected some of the path is a reader copying it, not opening it.
    if (event.type === "click" && !(window.getSelection()?.isCollapsed ?? true)) return;
    event.preventDefault();
    opener.open(target);
  };
  return (
    <>
      <div
        ref={ref}
        className="agent-panel-md__prose"
        onClick={opener === null ? undefined : openPath}
        onKeyDown={opener === null ? undefined : (event) => {
          if (event.key === "Enter") openPath(event);
        }}
      />
      {slots.map((slot, at) => {
        // The slot's own number, not its position: the prose is sanitized but still
        // transcript-authored, so a message that wrote this attribute itself must not be able to
        // shift every fence after it onto the wrong code.
        const index = Number(slot.getAttribute(FENCE_SLOT_ATTRIBUTE));
        const fence = Number.isInteger(index) ? fences[index] : undefined;
        if (fence === undefined) return null;
        return createPortal(<Fence block={fence} settled={settled} />, slot, `fence-${at}`);
      })}
    </>
  );
});

/**
 * One fenced block, wherever it was written.
 *
 * The single place that turns a fence into a component, so a fence nested in a list item is the
 * same thing to a reader as one at the top level -- highlighted, labelled, copyable -- and the
 * mermaid decision is made once rather than once per call site.
 */
function Fence({ block, settled }: { block: FenceBlock; settled: boolean }) {
  if (block.kind === "mermaid") {
    return settled
      ? <MermaidBlock code={block.code} />
      : <CodeBlock code={block.code} lang="mermaid" highlight={false} />;
  }
  return <CodeBlock code={block.code} lang={block.lang} highlight={settled} />;
}

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
        if (b.kind !== "prose") return <Fence key={i} block={b} settled={settled} />;
        return <ProseBlock key={i} html={b.html} fences={b.fences} settled={settled} />;
      })}
    </div>
  );
}
