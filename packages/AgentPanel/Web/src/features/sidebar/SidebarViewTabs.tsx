// The strip of views along the top of the sidebar, and the arrow keys that walk it. Out of
// `AgentSidebar` once a tab (Branches) needed the sidebar without it.

import { useCallback, useRef, type KeyboardEvent } from "react";
import { useDomSync } from "@/hooks/dom/useDomSync";

export type AgentSidebarMode = "sessions" | "bots" | "canvas" | "messages";

/**
 * Tab order, and the order the arrow keys walk.
 *
 * Canvas sits after Bots because it is derived from them: it is the same curated roster with the
 * "pick one" taken out. A reader who has not met it yet meets Bots first, which is the thing it is
 * a view of. Messages comes last because it is the only tab whose content did not come from this
 * machine: it is the hub's, across every machine, so it is the one a reader goes to rather than
 * reads past.
 */
const SIDEBAR_MODES: ReadonlyArray<{ mode: AgentSidebarMode; label: string }> = [
  { mode: "sessions", label: "Sessions" },
  { mode: "bots", label: "Bots" },
  { mode: "canvas", label: "Canvas" },
  { mode: "messages", label: "Messages" },
];

/**
 * Bring a tab into the strip, and only if it is not already in it.
 *
 * The strip scrolls when the views stop fitting, and the selected tab is the one that has to be
 * readable: a reader who arrives at "Messages" and sees "Sessions" has been told the name and left
 * to guess the rest. But a tab that is already on screen is not a problem, and scrolling to it
 * anyway is not free -- `scrollIntoView` walks every scrollable ancestor, so an unconditional call
 * on every tab click disturbs containers that have nothing to do with the strip. `nearest` keeps
 * the movement small; measuring first keeps the call from happening at all.
 *
 * The first ancestor that clips horizontally is the strip, and a tab inside its box is inside the
 * strip. If nothing clips, the whole strip is on screen and there is nothing to reveal.
 */
function revealInStrip(tab: HTMLButtonElement | null | undefined): void {
  if (!tab) return;
  const tabBox = tab.getBoundingClientRect();
  for (let node = tab.parentElement; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowX;
    if (overflow !== "auto" && overflow !== "scroll") continue;
    const stripBox = node.getBoundingClientRect();
    if (tabBox.left >= stripBox.left && tabBox.right <= stripBox.right) return;
    tab.scrollIntoView({ block: "nearest", inline: "nearest" });
    return;
  }
}

export function SidebarViewTabs(props: {
  mode: AgentSidebarMode;
  onModeChange: (mode: AgentSidebarMode) => void;
  /** The ids the sidebar gives each view's tab and panel, so each labels the other. */
  tabId: (mode: AgentSidebarMode) => string;
  panelId: (mode: AgentSidebarMode) => string;
}) {
  const { tabId, panelId } = props;
  const tabRefs = useRef(new Map<AgentSidebarMode, HTMLButtonElement | null>());
  const revealSelectedTab = useCallback(() => {
    revealInStrip(tabRefs.current.get(props.mode));
  }, [props.mode]);

  // On mount as well as on selection: a reader who reloads with a view remembered has not clicked
  // anything, and the remembered view is the one that has to be on screen when they arrive.
  useDomSync(() => {
    revealSelectedTab();
  }, [revealSelectedTab]);

  const selectMode = (mode: AgentSidebarMode, focus = false) => {
    props.onModeChange(mode);
    if (focus) {
      globalThis.requestAnimationFrame?.(() => tabRefs.current.get(mode)?.focus());
    }
    revealInStrip(tabRefs.current.get(mode));
  };

  // Roving by index rather than the two-way toggle this was when there were exactly two tabs:
  // a third made "left means the first one" wrong in both directions. Wrapping is the ARIA tabs
  // pattern, and it is what keeps the last tab one keystroke from the first.
  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const current = SIDEBAR_MODES.findIndex((tab) => tab.mode === props.mode);
    let next: number | null = null;
    if (event.key === "ArrowLeft") next = (current - 1 + SIDEBAR_MODES.length) % SIDEBAR_MODES.length;
    else if (event.key === "ArrowRight") next = (current + 1) % SIDEBAR_MODES.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = SIDEBAR_MODES.length - 1;
    if (next === null) return;
    event.preventDefault();
    selectMode(SIDEBAR_MODES[next]!.mode, true);
  };

  // Four views fit a phone drawer at the default type size and stop fitting when the reader raises
  // it or narrows the rail, so the strip scrolls rather than compressing the last tab into its own
  // truncation. `selectMode` scrolls the chosen one into view.
  return (
    <div
      role="tablist"
      aria-label="Agent views"
      className="flex min-w-0 flex-1 self-stretch overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {SIDEBAR_MODES.map(({ mode, label }) => (
        <button
          key={mode}
          ref={(node) => {
            tabRefs.current.set(mode, node);
          }}
          id={tabId(mode)}
          type="button"
          role="tab"
          aria-selected={props.mode === mode}
          aria-controls={panelId(mode)}
          tabIndex={props.mode === mode ? 0 : -1}
          onClick={() => selectMode(mode)}
          onKeyDown={handleTabKeyDown}
          className={`flex min-h-11 shrink-0 items-center whitespace-nowrap border-b-2 px-2 text-(length:--agent-panel-fs-sidebar-title,15px) font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset active:bg-muted/70 ${
            props.mode === mode
              ? "border-primary text-foreground"
              : "border-transparent text-muted-foreground hover:bg-muted/60 hover:text-foreground"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
