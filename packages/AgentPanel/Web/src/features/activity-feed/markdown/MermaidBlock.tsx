"use client";

import { useEffect, useId, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";

// Mermaid is the one renderer that is genuinely async and changes height a lot
// (a text fence becomes a rendered SVG). To keep the virtualized feed's initial
// layout stable, diagrams render expand-on-demand: collapsed by default, off
// the initial measurement pass, and `mermaid` itself is dynamically imported
// only when first opened so it never bloats the base bundle. A single
// deliberate expansion is handled fine by the row's own ResizeObserver, the
// same way tool bodies expand.
export function MermaidBlock({ code }: { code: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="agent-panel-mermaid">
      <button
        type="button"
        className="agent-panel-mermaid__toggle"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <ChevronRight
          className={"size-[1em] shrink-0 transition-transform " + (open ? "rotate-90" : "")}
          aria-hidden
        />
        <span>Mermaid diagram</span>
      </button>
      {open ? <MermaidRender code={code} /> : null}
    </div>
  );
}

function MermaidRender({ code }: { code: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const reactId = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const mermaid = (await import("mermaid")).default;
        // securityLevel "strict" sanitizes label HTML and disables click
        // handlers — diagram source comes from agent transcripts, treat as
        // untrusted.
        mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "dark" });
        const { svg } = await mermaid.render(`agent-panel-mmd-${reactId}`, code);
        if (alive && ref.current) ref.current.innerHTML = svg;
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : "diagram render failed");
      }
    })();
    return () => {
      alive = false;
    };
  }, [code, reactId]);

  if (error) {
    return (
      <pre className="agent-panel-mermaid__error">
        <code>{code}</code>
      </pre>
    );
  }
  return <div ref={ref} className="agent-panel-mermaid__body" />;
}
