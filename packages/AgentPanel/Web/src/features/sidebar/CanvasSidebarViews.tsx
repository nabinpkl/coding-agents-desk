// The Canvas tab's two views: the Bots on the canvas, and every session on this machine.
//
// The second exists so a session no Bot holds can be read without leaving the canvas. Picking one
// opens it in a modal over the strip rather than in the main column, which is the canvas's and
// stays that way.

import { useId, useRef, type KeyboardEvent, type ReactNode } from "react";

export type CanvasSidebarView = "bots" | "sessions";

const VIEWS: ReadonlyArray<{ view: CanvasSidebarView; label: string }> = [
  { view: "bots", label: "Bots" },
  { view: "sessions", label: "Sessions" },
];

export function CanvasSidebarViews({
  view,
  onViewChange,
  bots,
  sessions,
}: {
  view: CanvasSidebarView;
  onViewChange: (view: CanvasSidebarView) => void;
  bots: ReactNode;
  sessions: ReactNode;
}) {
  const groupId = useId();
  const tabs = useRef(new Map<CanvasSidebarView, HTMLButtonElement | null>());

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const current = VIEWS.findIndex((entry) => entry.view === view);
    let next: number | null = null;
    if (event.key === "ArrowLeft") next = (current - 1 + VIEWS.length) % VIEWS.length;
    else if (event.key === "ArrowRight") next = (current + 1) % VIEWS.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = VIEWS.length - 1;
    if (next === null) return;
    event.preventDefault();
    const target = VIEWS[next]!.view;
    onViewChange(target);
    globalThis.requestAnimationFrame?.(() => tabs.current.get(target)?.focus());
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-border px-2 py-1.5">
        <div role="tablist" aria-label="Canvas views" className="flex rounded-lg bg-muted p-0.5">
          {VIEWS.map((entry) => {
            const selected = entry.view === view;
            return (
              <button
                key={entry.view}
                ref={(node) => {
                  tabs.current.set(entry.view, node);
                }}
                id={`${groupId}-${entry.view}-tab`}
                type="button"
                role="tab"
                aria-selected={selected}
                aria-controls={`${groupId}-${entry.view}-panel`}
                tabIndex={selected ? 0 : -1}
                onClick={() => onViewChange(entry.view)}
                onKeyDown={handleKeyDown}
                className={`flex min-h-8 flex-1 cursor-pointer items-center justify-center rounded-md px-2 text-(length:--agent-panel-fs-sidebar-meta,13px) font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary ${
                  selected
                    ? "bg-card text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground active:bg-card/60"
                }`}
              >
                {entry.label}
              </button>
            );
          })}
        </div>
      </div>
      <div
        id={`${groupId}-${view}-panel`}
        role="tabpanel"
        aria-labelledby={`${groupId}-${view}-tab`}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
      >
        {view === "bots" ? bots : sessions}
      </div>
    </div>
  );
}
