// Turning Markdown source into the blocks the renderer paints, once for a finished
// document and incrementally for one that is still being written.
//
// Everything here is pure: no React, no DOM beyond DOMPurify's own. The component
// that uses it is `Markdown.tsx`.

import { Marked, type Token, type TokensList } from "marked";
import markedKatex from "marked-katex-extension";
import DOMPurify from "dompurify";

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

export type Block =
  | { kind: "prose"; html: string }
  | { kind: "code"; code: string; lang: string }
  | { kind: "mermaid"; code: string };

/**
 * Appends `tokens` to `into`, peeling fenced code (and mermaid) out into their own
 * blocks and rendering runs of prose tokens as one sanitized HTML chunk.
 *
 * A leading prose run merges into a prose block already at the end of `into` rather
 * than starting a second one. That is what lets the incremental path add to a
 * document without changing its shape: `.agent-panel-md__prose > :first-child` zeroes
 * the top margin, so a paragraph that moved into a prose block of its own would sit
 * at a different distance from the one above it. One prose element per run, however
 * many passes built it.
 *
 * Reference-style link definitions live on the lexer's `links` map, so each run
 * carries it forward for the parser.
 */
function appendTokens(into: Block[], tokens: readonly Token[], links: TokensList["links"]): void {
  let prose: Token[] = [];

  const flushProse = () => {
    if (prose.length === 0) return;
    const run = prose as unknown as TokensList;
    run.links = links;
    const html = sanitizeProse(marked.parser(run));
    const last = into[into.length - 1];
    // Replaced, not mutated: the incremental path hands out an array that shares
    // these objects with its own settled list, and growing one in place would edit
    // a block a caller is still holding.
    if (last?.kind === "prose") into[into.length - 1] = { kind: "prose", html: last.html + html };
    else into.push({ kind: "prose", html });
    prose = [];
  };

  for (const token of tokens) {
    if (token.type === "code") {
      flushProse();
      // marked keeps the whole fence info string in `lang` (e.g. "js {1,3}");
      // take the first word so highlight hints don't defeat grammar lookup.
      const info = (token.lang ?? "").trim().split(/\s+/)[0] ?? "";
      if (info.toLowerCase() === "mermaid") {
        into.push({ kind: "mermaid", code: token.text });
      } else {
        into.push({ kind: "code", code: token.text, lang: info });
      }
    } else {
      prose.push(token);
    }
  }
  flushProse();
}

/** Every block of a finished document, read from the start. */
export function toBlocks(content: string): Block[] {
  const tokens = marked.lexer(content);
  const blocks: Block[] = [];
  appendTokens(blocks, tokens, tokens.links);
  return blocks;
}

/**
 * How much of the tail is re-read on every pass.
 *
 * Two things have to fit inside it. The obvious one is Markdown's own instability:
 * the last top-level token is the only one an append can still change, so it can
 * never be settled. The other is that the caller's text is not strictly growing --
 * `markdownSafePrefix` hides an unterminated marker by trimming up to `MAX_TRIM`
 * (200) characters back off the end, so tick N can be SHORTER than tick N-1. A
 * window comfortably wider than that trim is what keeps the settled prefix a prefix,
 * and therefore what keeps this from throwing its work away every time the model
 * types an asterisk.
 */
const LIVE_WINDOW = 512;

export interface StreamingBlocks {
  /** Blocks for `content`. Identical to `toBlocks(content)`, computed incrementally. */
  (content: string): Block[];
}

/**
 * A `toBlocks` that does not re-read the part of the document that is finished.
 *
 * While a message streams, the panel re-renders it about thirty times a second, and
 * the old path lexed, parsed and sanitized the WHOLE document each time -- so the
 * per-tick cost grew with the message and the total grew with its square. Measured
 * on a real 19,757-character assistant message: 2.84ms per tick, 435ms to reveal
 * once. Through here: 0.87ms and 133ms.
 *
 * The saving rests on two properties of marked, both verified against real
 * transcripts and against fences, tables, lists, setext headings and reference
 * links: a token's `raw` fields concatenate back to exactly the input, so a token
 * boundary is a byte offset; and parsing tokens one run at a time produces byte-
 * identical HTML to parsing them all at once, so a document's HTML is the
 * concatenation of its parts. Together they mean everything older than `LIVE_WINDOW`
 * can be parsed once and kept.
 *
 * Returns the SAME blocks the whole-document path would, and falls back to it
 * outright if either property ever fails to hold -- the correctness of the render
 * does not depend on the optimization being applicable. The equivalence is asserted
 * tick by tick over a whole reveal in `proseBlocks.test.ts`, which is where a change
 * to marked would announce itself.
 *
 * One splitter per streaming message; it holds that message's settled prefix.
 */
export function createStreamingBlocks(): StreamingBlocks {
  let settledText = "";
  let settled: Block[] = [];
  let links: TokensList["links"] = {};
  // React renders twice under StrictMode, and a caller may re-render for reasons of
  // its own, so the same content must not advance the state a second time.
  let lastContent: string | null = null;
  let lastBlocks: Block[] = [];

  const restart = (content: string): Block[] => {
    settledText = "";
    settled = [];
    links = {};
    lastContent = content;
    lastBlocks = toBlocks(content);
    return lastBlocks;
  };

  return (content: string): Block[] => {
    if (content === lastContent) return lastBlocks;
    // A revision rather than an append -- a re-render of an earlier message, or a
    // trim that reached further back than the live window. Nothing before it is
    // known to still be true.
    if (!content.startsWith(settledText)) return restart(content);

    const tail = content.slice(settledText.length);
    const tokens = marked.lexer(tail);
    Object.assign(links, tokens.links);

    // Everything but the last token is a candidate, and a candidate settles once it
    // ends outside the live window.
    let settledTokens = 0;
    let settledChars = 0;
    for (let index = 0; index < tokens.length - 1; index += 1) {
      const end = settledChars + tokens[index]!.raw.length;
      if (tail.length - end < LIVE_WINDOW) break;
      settledChars = end;
      settledTokens = index + 1;
    }
    if (settledTokens > 0) {
      // The offsets above are byte offsets only if these tokens' `raw` really do tile
      // the text they came from. Checked over the settled tokens ALONE, not the whole
      // tail, because the last token is where marked normalizes: a half-typed bullet
      // arrives as `"- "` and comes back as `"-\n"`, which is not a mismatch worth
      // throwing away a document over -- and never lands in a token being settled.
      const consumed = tokens.slice(0, settledTokens).map((token) => token.raw).join("");
      if (consumed !== tail.slice(0, settledChars)) return restart(content);
      appendTokens(settled, tokens.slice(0, settledTokens), links);
      settledText += consumed;
    }

    const blocks = settled.slice();
    appendTokens(blocks, tokens.slice(settledTokens), links);
    lastContent = content;
    lastBlocks = blocks;
    return blocks;
  };
}
