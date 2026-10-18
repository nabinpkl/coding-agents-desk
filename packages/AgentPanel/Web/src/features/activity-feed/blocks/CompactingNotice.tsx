import { useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { COLUMN_GUTTER_CLASS } from "@/features/activity-feed/blocks/ActivityEventHeading";
import { useDomSync } from "@/hooks/dom/useDomSync";

/** How near the bottom a reader has to be for the summary to keep following what arrives. */
const FOLLOW_SLACK_PX = 8;

const CHIP_CLASS =
  "flex shrink-0 items-center gap-1.5 rounded-full border session-view-compaction px-2 py-0.5 font-mono uppercase tracking-wider text-foreground/70 shadow-sm";
const CHIP_STYLE = { fontSize: "var(--agent-panel-fs-tile-chip, 12px)" };

/**
 * The context being rewritten, said while it is happening, with the summary being written under it.
 *
 * Deliberately the same shape as the compaction banner -- a chip between two hairlines -- because it
 * becomes that banner. A compaction takes two to four minutes on a large context and writes no
 * transcript line until it lands, so without this the thread simply stops, which is also what a
 * finished turn looks like.
 *
 * The summary sits UNDER the chip, never in the thread. It used to stream into the thread as a live
 * row, and for minutes that row sat on top of the banner saying the context was reset. In its own
 * box it can be read while it is written, and folded away by a reader who wants the rows behind it.
 * It goes when the compaction lands, because the summary that lands is in the transcript.
  * Fixed viewport height, not content-sized: a growing box pushes the chip upward for the whole
  * compaction.
 *
 * It is an overlay rather than a row: there is no event behind it, and a row in the virtual list
 * would have to be given an index in a numbering the transcript owns.
 */
export function CompactingNotice({ summary }: { summary: string }) {
  const [open, setOpen] = useState(true);
  const scroller = useRef<HTMLDivElement>(null);
  // Follows the newest text until the reader scrolls up to read something earlier.
  const following = useRef(true);
  useDomSync(() => {
    const box = scroller.current;
    if (box && following.current) box.scrollTop = box.scrollHeight;
  }, [summary, open]);

  const writing = summary.length > 0;
  const label = (
    <>
      {/* The one moving thing on a surface that is otherwise frozen, which is the whole point:
          a still chip reads as a state somebody left behind. */}
      <span className="size-1.5 animate-pulse rounded-full bg-amber-500 motion-reduce:animate-none" aria-hidden />
      <span role="status">Compacting the context</span>
    </>
  );
  return (
    <div
      className={`pointer-events-none absolute inset-0 z-20 flex flex-col justify-end gap-2 pb-2 ${COLUMN_GUTTER_CLASS}`}
      style={{ fontSize: "var(--agent-panel-fs-tile-other-text, 16px)" }}
    >
      <div className="flex items-center gap-2 text-muted-foreground">
        <span className="h-px flex-1 bg-border" aria-hidden />
        {writing ? (
          <button
            type="button"
            aria-expanded={open}
            title={open ? "Hide the summary" : "Show the summary being written"}
            onClick={() => setOpen((value) => !value)}
            className={`${CHIP_CLASS} pointer-events-auto cursor-pointer outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary`}
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
      {writing && open ? (
        <div
          ref={scroller}
          onScroll={(event) => {
            const box = event.currentTarget;
            following.current = box.scrollHeight - box.scrollTop - box.clientHeight <= FOLLOW_SLACK_PX;
          }}
          className="pointer-events-auto h-[30vh] shrink-0 overflow-y-auto overscroll-contain rounded-md border session-view-compaction px-3 py-2 shadow-sm"
        >
          <p className="whitespace-pre-wrap break-words text-foreground">{summary}</p>
        </div>
      ) : null}
    </div>
  );
}
