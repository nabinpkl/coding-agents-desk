"use client";

// The row a thread draws where it holds no rows: between the range opened around a jump and the
// live window, or across a reconnect that outran a window (ADR-0125). It loads as it comes near the
// viewport (`useGapFill`), so what it says is that the lines are on their way, or that they could
// not be read and how to ask again.

import { COLUMN_GUTTER_CLASS } from "@/features/activity-feed/blocks/ActivityEventHeading";

const CHIP_CLASS =
  "flex shrink-0 items-center gap-1.5 rounded-full border border-dashed border-border px-2 py-0.5 font-mono uppercase tracking-wider text-muted-foreground";
const CHIP_STYLE = { fontSize: "var(--agent-panel-fs-tile-chip, 12px)" };

export function GapRow({ failed, onRetry }: { failed: boolean; onRetry: () => void }) {
  return (
    <div
      className={`${COLUMN_GUTTER_CLASS} py-[0.5em]`}
      style={{ fontSize: "var(--agent-panel-fs-tile-other-text, 16px)" }}
      role="status"
      aria-live="polite"
    >
      <div className="flex items-center gap-2 text-muted-foreground">
        <span className="h-px flex-1 border-t border-dashed border-border" aria-hidden />
        {failed ? (
          <span className={CHIP_CLASS} style={CHIP_STYLE}>
            <span>These lines did not load</span>
            <button
              type="button"
              onClick={onRetry}
              className="cursor-pointer rounded-sm px-1 text-foreground underline-offset-2 outline-none transition-colors hover:underline focus-visible:ring-2 focus-visible:ring-primary"
            >
              Retry
            </button>
          </span>
        ) : (
          <span className={CHIP_CLASS} style={CHIP_STYLE}>
            Loading lines…
          </span>
        )}
        <span className="h-px flex-1 border-t border-dashed border-border" aria-hidden />
      </div>
    </div>
  );
}
