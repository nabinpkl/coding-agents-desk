// The grip between two panes.
//
// The callback reports how much the LEADING pane grew, never a raw client coordinate: the sign
// flip between "the pointer moved left" and "the sidebar shrank" belongs in one place, and every
// consumer of a divider in this repo takes semantic growth (AGENTS.md, "Code").

import { useCallback, useRef } from "react";

const STEP = 24;

export function PaneDivider({
  axis,
  label,
  onGrow,
}: {
  axis: "vertical" | "horizontal";
  label: string;
  /** Pixels the leading pane gained. Negative means it lost them. */
  onGrow: (pixels: number) => void;
}) {
  const last = useRef<number | null>(null);
  const vertical = axis === "vertical";

  const move = useCallback((event: PointerEvent) => {
    const position = vertical ? event.clientX : event.clientY;
    if (last.current === null) {
      last.current = position;
      return;
    }
    // For a horizontal divider the leading pane is the one ABOVE it, so a downward drag grows it;
    // for a vertical divider the leading pane is on the left and a rightward drag grows it. Both
    // are "pointer delta", which is why one expression covers them.
    onGrow(position - last.current);
    last.current = position;
  }, [onGrow, vertical]);

  const release = useCallback(() => {
    last.current = null;
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", release);
    window.removeEventListener("pointercancel", release);
  }, [move]);

  return (
    <div
      role="separator"
      aria-label={label}
      aria-orientation={vertical ? "vertical" : "horizontal"}
      tabIndex={0}
      onPointerDown={(event) => {
        event.preventDefault();
        last.current = vertical ? event.clientX : event.clientY;
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", release);
        window.addEventListener("pointercancel", release);
      }}
      onKeyDown={(event) => {
        // The keyboard path exists because a separator that only answers a pointer is unreachable
        // for anyone driving the panel from a keyboard, and this one hides a whole pane.
        const back = vertical ? "ArrowLeft" : "ArrowUp";
        const forward = vertical ? "ArrowRight" : "ArrowDown";
        if (event.key !== back && event.key !== forward) return;
        event.preventDefault();
        onGrow(event.key === forward ? STEP : -STEP);
      }}
      className={`shrink-0 bg-border outline-none transition-colors hover:bg-primary/60
        focus-visible:bg-primary ${vertical
          ? "w-1 cursor-col-resize"
          : "h-1 cursor-row-resize"}`}
    />
  );
}
