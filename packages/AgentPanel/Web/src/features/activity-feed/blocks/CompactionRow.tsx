import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { RawDetails } from "@/features/activity-feed/blocks/ActivitySystemBlocks";
import { COLUMN_GUTTER_CLASS } from "@/features/activity-feed/blocks/ActivityEventHeading";
import { Markdown } from "@/features/activity-feed/markdown/Markdown";
import type { EventRowContext } from "@/features/activity-feed/blocks/ActivityEventRows";
import { compactionSummary } from "@/features/activity-feed/rows/activityDisplayItems";
import { partitionEventBlocks } from "@/features/activity-feed/rows/activityFeedLayout";
import type { ActivityEvent } from "@/features/activity-feed/useSessionEventsStream";

const CHIP_CLASS =
  "flex shrink-0 items-center gap-1.5 rounded-full border session-view-compaction px-2 py-0.5 font-mono uppercase tracking-wider text-foreground/70";
const CHIP_STYLE = { fontSize: "var(--agent-panel-fs-tile-chip, 12px)" };

/**
 * Horizontal milestone banner that marks where the harness compacted the
 * model's context. Sits between turn clusters so the viewer can see the reset
 * point; the size the context dropped TO rides the same event as an occupancy
 * report, so the token meter moves on this row rather than on the next turn.
 *
 * The chip opens the summary the context was replaced with, when the event carries one: it is what
 * the session remembers of everything above the banner, and the same text `CompactingNotice`
 * showed being written. Closed by default: open, every banner spent a 16em box on text a reader
 * scrolling a compacted session has usually already moved past, and the chevron on the chip says
 * there is something to open.
 */
export function CompactionRow({
  ev,
  ctx,
}: {
  ev: ActivityEvent;
  ctx: EventRowContext;
}) {
  const [open, setOpen] = useState(false);
  const when = ev.ts ? new Date(ev.ts).toLocaleTimeString() : "";
  const summary = compactionSummary(ev);
  const { folded, hasRawJson } = partitionEventBlocks(ev);
  const label = (
    <>
      <span>Context compacted</span>
      {when ? <span className="text-muted-foreground/70">{when}</span> : null}
    </>
  );
  return (
    <div
      className={`${COLUMN_GUTTER_CLASS} py-[0.5em]`}
      style={{ fontSize: "var(--agent-panel-fs-tile-other-text, 16px)" }}
    >
      <div className="flex items-center gap-2 text-muted-foreground">
        <span className="h-px flex-1 bg-border" aria-hidden />
        {summary ? (
          <button
            type="button"
            aria-expanded={open}
            title={open ? "Hide the summary" : "Show the summary"}
            onClick={() => setOpen((value) => !value)}
            className={`${CHIP_CLASS} cursor-pointer outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary`}
            style={CHIP_STYLE}
          >
            {label}
            <ChevronDown
              className={`size-3 transition-transform motion-reduce:transition-none ${open ? "" : "-rotate-90"}`}
              aria-hidden
            />
          </button>
        ) : (
          <span className={CHIP_CLASS} style={CHIP_STYLE}>{label}</span>
        )}
        <span className="h-px flex-1 bg-border" aria-hidden />
      </div>
      {summary && open ? (
        // Scrolls in its own box: a summary runs to tens of kilobytes, and a row that tall would
        // push the rest of the thread a screen away from the banner it belongs to. Kept short so
        // the thread around the banner stays in view while it is open. Markdown because the
        // summariser writes numbered sections and nested lists.
        <div className="mt-2 max-h-[16em] overflow-y-auto overscroll-contain rounded-md border session-view-compaction px-3 py-2 leading-(--agent-panel-prose-leading) text-foreground">
          <Markdown content={summary} />
        </div>
      ) : null}
      <div className="mt-1">
        <RawDetails
          metadata={folded}
          session={ctx.session}
          rawSource={ctx.rawSource}
          eventIndex={ev.index}
          includesRawJson={hasRawJson}
        />
      </div>
    </div>
  );
}
