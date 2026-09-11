"use client";

import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { SHIKI_THEMES, useCodeHighlighting } from "@/features/activity-feed/markdown/highlighter";
// Declared here, not inherited. This component is exported and used outside the markdown
// renderer, where `Markdown.tsx` may never be imported -- and the failure mode of a missing
// stylesheet is unstyled markup rather than an error. The bundler dedupes the double import.
import "@/features/activity-feed/markdown/markdown.css";

// A fenced code block. Renders a plain <pre> synchronously (correct height on
// first paint), then swaps in Shiki-highlighted markup once the singleton
// highlighter loads. Highlighting only recolors tokens, so the swap does not
// change the row's measured height — the property the virtualized feed relies
// on. Chrome (language label + copy button) is plain shadcn-style markup.
//
// `highlight` is false for a fence that has not closed yet. A partial snippet
// tokenizes differently on every reveal tick (an unterminated string, a half-typed
// keyword), so highlighting one recolors it thirty times a second; the plain <pre>
// is the same text without the strobe, and the real colors arrive when it lands.
// Memoized: while a message streams, the renderer re-runs about thirty times a
// second, and every fence ABOVE the one being typed is handed the same three
// primitive props each time. Nothing here depends on anything but those props.
export const CodeBlock = memo(function CodeBlock({
  code,
  lang,
  highlight = true,
  wrap = false,
}: {
  code: string;
  lang: string;
  highlight?: boolean;
  /**
   * Wrap long lines instead of scrolling them. Off by default because a fence in
   * the transcript is usually source, which is read by its indentation. Turn it
   * on where the block is a single command, where there is no shape to lose and
   * the horizontal scrollbar just hides the line behind a gesture.
   */
  wrap?: boolean;
}) {
  const { highlighter, lang: grammar } = useCodeHighlighting(lang);
  const html = useMemo(() => {
    if (!highlighter || !highlight) return null;
    try {
      return highlighter.codeToHtml(code, {
        lang: grammar,
        themes: SHIKI_THEMES,
        defaultColor: false,
      });
    } catch {
      return null;
    }
  }, [highlighter, code, grammar, highlight]);

  return (
    <div className={wrap ? "agent-panel-code agent-panel-code--wrap" : "agent-panel-code"}>
      <div className="agent-panel-code__head">
        <span className="agent-panel-code__lang">{lang || "text"}</span>
        <CopyButton text={code} />
      </div>
      {html ? (
        <div className="agent-panel-code__body" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre className="agent-panel-code__body agent-panel-code__fallback">
          <code>{code}</code>
        </pre>
      )}
    </div>
  );
});

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  return (
    <button
      type="button"
      className="agent-panel-code__copy"
      aria-label={copied ? "Copied" : "Copy code"}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => setCopied(false), 1200);
        });
      }}
    >
      {copied ? <Check className="size-[1em]" aria-hidden /> : <Copy className="size-[1em]" aria-hidden />}
    </button>
  );
}
