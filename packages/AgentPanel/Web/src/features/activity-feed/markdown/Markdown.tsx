"use client";

import { useLayoutEffect, useMemo, useRef } from "react";
import { Marked, type Token, type TokensList } from "marked";
import markedKatex from "marked-katex-extension";
import DOMPurify from "dompurify";
import "katex/dist/katex.min.css";
import "./markdown.css";
import { CodeBlock } from "./CodeBlock";
import { MermaidBlock } from "./MermaidBlock";
import { applyProseHtml } from "./patchProse";

// One Marked instance for the whole app. GFM on; KaTeX rendered synchronously
// (renderToString) so math has its correct height on first paint. `breaks`
// stays off so transcript prose wraps like standard Markdown.
const marked = new Marked({ gfm: true, breaks: false });
marked.use(markedKatex({ throwOnError: false, output: "html" }));

// KaTeX renders math with inline `style` (heights, vertical-align, margins,
// vlist offsets), so the `style` attribute has to survive sanitization. But
// marked also passes raw HTML from the (untrusted) transcript into the prose
// bucket, and a blanket `style` allowance would let `position:fixed; z-index`
// markup paint a full-viewport clickjacking overlay from inside one feed row.
// So we keep `style` but strip the declarations that enable overlays
// (position / z-index / inset) and any url()/expression() value — KaTeX uses
// none of those, so math is unaffected.
export function scrubStyle(style: string): string {
  return style
    .split(";")
    .filter((decl) => {
      const idx = decl.indexOf(":");
      if (idx < 0) return false;
      const prop = decl.slice(0, idx).trim().toLowerCase();
      const value = decl.slice(idx + 1).toLowerCase();
      if (prop === "position" || prop === "z-index" || prop === "inset") return false;
      if (value.includes("url(") || value.includes("expression(")) return false;
      return true;
    })
    .join(";");
}

let styleHookInstalled = false;

// Sanitize marked's prose HTML. Shiki output (CodeBlock) and Mermaid SVG are
// produced by separate trusted/sanitized paths and never flow through here.
function sanitizeProse(html: string): string {
  // The feed has no real content during SSR (events arrive over a client
  // subscription after mount), so server renders nothing and there is no
  // hydration mismatch. The guard only protects the non-browser code path.
  if (typeof window === "undefined") return "";
  if (!styleHookInstalled) {
    DOMPurify.addHook("uponSanitizeAttribute", (_node, data) => {
      if (data.attrName === "style") data.attrValue = scrubStyle(data.attrValue);
    });
    styleHookInstalled = true;
  }
  return DOMPurify.sanitize(html, { ADD_ATTR: ["style"] });
}

type Block =
  | { kind: "prose"; html: string }
  | { kind: "code"; code: string; lang: string }
  | { kind: "mermaid"; code: string };

// Split the document into top-level blocks, peeling fenced code (and mermaid)
// out into their own React components while rendering runs of prose tokens as
// one sanitized HTML chunk. Reference-style link definitions live on the
// lexer's `links` map, so each prose run carries it forward for the parser.
export function toBlocks(content: string): Block[] {
  const tokens = marked.lexer(content);
  const links = tokens.links;
  const blocks: Block[] = [];
  let prose: Token[] = [];

  const flushProse = () => {
    if (prose.length === 0) return;
    const run = prose as unknown as TokensList;
    run.links = links;
    blocks.push({ kind: "prose", html: sanitizeProse(marked.parser(run)) });
    prose = [];
  };

  for (const token of tokens) {
    if (token.type === "code") {
      flushProse();
      // marked keeps the whole fence info string in `lang` (e.g. "js {1,3}");
      // take the first word so highlight hints don't defeat grammar lookup.
      const info = (token.lang ?? "").trim().split(/\s+/)[0] ?? "";
      if (info.toLowerCase() === "mermaid") {
        blocks.push({ kind: "mermaid", code: token.text });
      } else {
        blocks.push({ kind: "code", code: token.text, lang: info });
      }
    } else {
      prose.push(token);
    }
  }
  flushProse();
  return blocks;
}

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
function ProseBlock({ html }: { html: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    if (renderedHtml.get(el) === html) return;
    applyProseHtml(el, renderedHtml.get(el) ?? "", html);
    renderedHtml.set(el, html);
  }, [html]);
  return <div ref={ref} className="agent-panel-md__prose" />;
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
export function Markdown({ content, streaming = false }: { content: string; streaming?: boolean }) {
  const blocks = useMemo(() => toBlocks(content), [content]);
  return (
    <div className="agent-panel-md">
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
