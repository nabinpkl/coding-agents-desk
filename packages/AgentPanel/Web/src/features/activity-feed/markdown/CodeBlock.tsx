"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { resolveLang, SHIKI_THEMES, useHighlighter } from "./highlighter";

// A fenced code block. Renders a plain <pre> synchronously (correct height on
// first paint), then swaps in Shiki-highlighted markup once the singleton
// highlighter loads. Highlighting only recolors tokens, so the swap does not
// change the row's measured height — the property the virtualized feed relies
// on. Chrome (language label + copy button) is plain shadcn-style markup.
export function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const hl = useHighlighter();
  const html = useMemo(() => {
    if (!hl) return null;
    try {
      return hl.codeToHtml(code, {
        lang: resolveLang(lang),
        themes: SHIKI_THEMES,
        defaultColor: false,
      });
    } catch {
      return null;
    }
  }, [hl, code, lang]);

  return (
    <div className="agent-panel-code">
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
}

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
