"use client";

// The chip at the head of an event: which role it is, whether it is collapsed, and the
// prompt-cache badge that rides beside it.
//
// Split from the rows because the float, the clearance and the chip's own leading are a
// typographic argument with measurements in it, and nothing about which rows exist.

import { ChevronRight } from "lucide-react";
import type { ActivityEvent, EventCacheHit } from "@/features/activity-feed/useSessionEventsStream";
import { type DisplayRole } from "@/features/activity-feed/rows/activityDisplayItems";
import { toolIntent } from "@/features/activity-feed/rows/activityEventText";
import type { SessionReference } from "@/features/activity-feed/data-source/AgentDataSource";

/**
 * The per-turn prompt-cache badge: the actual cached and total input token
 * counts, e.g. `cached 13,184 / 31,428`, next to the row the turn's usage
 * belongs to. The hit fraction rides in the tooltip and accessible label.
 * Rendered only while the cache-hits toggle is on.
 */
export function CacheBadge({ cacheHit }: { cacheHit: EventCacheHit }) {
  const fraction = cacheHit.input > 0 ? cacheHit.cached / cacheHit.input : 0;
  const percent = Math.min(100, Math.max(0, Math.round(fraction * 100)));
  return (
    <span
      title={`${cacheHit.cached.toLocaleString()} of ${cacheHit.input.toLocaleString()} input tokens served from the prompt cache (${percent}%)`}
      aria-label={`Prompt cache: ${cacheHit.cached.toLocaleString()} of ${cacheHit.input.toLocaleString()} input tokens`}
      className="ml-[0.5em] shrink-0 rounded-sm bg-emerald-500/15 px-[0.35em] py-[0.1em] font-mono text-(length:--agent-panel-fs-tile-chip,12px) leading-none tabular-nums text-emerald-600 dark:text-emerald-400"
    >
      cached {cacheHit.cached.toLocaleString()} / {cacheHit.input.toLocaleString()}
    </span>
  );
}

export const ROLE_STYLES: Record<DisplayRole, string> = {
  user: "bg-primary/15 text-primary",
  assistant: "bg-muted text-foreground/80",
  tool: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  result: "bg-foreground/10 text-foreground/70",
  // Reasoning is the model's internal thought; muted so it reads as
  // commentary, not headline.
  reasoning: "bg-violet-500/15 text-violet-600 dark:text-violet-300",
  system: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
};

// Solid accent line per role, used as the left border on the secondary
// sticky so the role is recognizable at a glance.
export const ROLE_BORDER: Record<DisplayRole, string> = {
  user: "border-l-primary",
  assistant: "border-l-muted-foreground/50",
  tool: "border-l-amber-500",
  result: "border-l-foreground/40",
  reasoning: "border-l-violet-500",
  system: "border-l-sky-500",
};

/**
 * Nice lets model prose and reasoning read as one response, and leaves a tool call to its own chip
 * (`Bash`, `Read`), which already says a tool ran and which one. Raw keeps every other role label.
 *
 * A person's message is never labelled, in either mode: its card sits on the right in the
 * reader's own tint, which says who wrote it before a word of it is read.
 */
export function showEventRoleLabel(
  mode: SessionReference["mode"],
  role: DisplayRole,
): boolean {
  if (role === "user") return false;
  return mode === "raw" || (role !== "assistant" && role !== "reasoning" && role !== "tool");
}

// `leading-none` is load-bearing, not cosmetic. The heading floats, and a float
// taller than one line of body text overlaps the SECOND line too, indenting it
// as well -- at the 16px/1.375 body the line is 22px, and the chip's default
// leading pushed the float past it, so a two-line paragraph came out fully
// indented and gave back the width this heading was meant to save.
//

// The chip is its own token (`tile_chip`, 12px) and does not scale with the
// body, so the clearance is whatever `tile_other_text` is minus a constant.
// Raising the body default to 16 widened it; the 10px floor is the narrow end
// and is where to look first if the chip's leading or padding ever changes.
export const CHIP_CLASS =
  "rounded-sm px-[0.4em] py-[0.15em] font-mono text-(length:--agent-panel-fs-tile-chip,12px) font-bold uppercase leading-none tracking-wider ";
/**
 * The space either side of everything that spans the session's column: every transcript row, the
 * sticky headers over them, the summary and extension bands under them, and the composer. One
 * expression because they are one edge -- a band that started somewhere else would be saying it
 * belongs to something other than the text above it.
 *
 * As a share of the column rather than a number.
 *
 * Twenty-four was right for the thread view, which is the whole page, and wrong everywhere the
 * feed is narrow: on a Bot card an open session is around 450 wide, so the pair of them spent a
 * tenth of it on nothing, and on a phone at 390 the same 48 pixels is worse still. It also read as
 * space held back for a scrollbar, and nothing is held back -- this panel gets overlay scrollbars,
 * and the scroller was measured taking zero layout width both on the real panel and in a headless
 * Chrome, so the thumb floats over this gutter rather than being given it.
 *
 * A PERCENTAGE, not a container query, and the difference is containment. Percentage padding
 * resolves against the containing block's inline size, which here is the transcript column itself,
 * so this reads the width with no `container-type` anywhere -- and `container-type: inline-size`
 * carries `contain: layout`, which would make whichever element held it the containing block for
 * every absolutely positioned descendant inside it. A session's tasks panel is positioned against
 * its CARD, so moving that anchor is a real change to make for a gutter.
 *
 * Three percent, floored at 12 and capped at 24. The cap is where the thread view sits and is why
 * the full-page view is untouched: it reaches 24 at an 800px column and every page-width column is
 * past that. The floor is what a phone and a small card get. Between them it ramps, so a card the
 * reader has dragged wider gets a gutter to match rather than a step at some threshold nobody
 * chose.
 */
export const COLUMN_GUTTER_CLASS = "px-[clamp(0.75rem,3%,1.5rem)]";

/**
 * The width a session's column stops growing at, and the centring that goes with it.
 *
 * The other half of the gutter above: that one is the space either side of the column, this is the
 * column's own measure -- how many characters a line of prose holds before the eye stops finding
 * the next one. A line across a whole window is not a wider line of text, it is a line nobody
 * finishes.
 *
 * Measured on the live panel at the reader's default sizes, as characters per full line of the
 * column. A thread view 1176 wide -- a 1440 window with the sidebar open -- carries 120 characters
 * of body prose at 16px and 167 of italic reasoning at 14px. The Father home, at 870, already sits
 * where this reads: 89 and 124. So the cap is that width, and a wide thread view is brought to the
 * measure the drawer has been showing all along rather than given a new one. At 48rem it is 78
 * characters of body prose and 109 of reasoning, verified the same way.
 *
 * `rem`, not a font token, because the body size IS a token the reader can scale
 * (`--agent-panel-fs-…`). A cap in the reader's own font would hold the pixels and let the
 * characters per line fall as the text grows; a cap in rem keeps the measure and lets the line get
 * shorter, which is the right way round for larger type.
 *
 * `mx-auto` because a capped column that stays pinned to the left is not centred, only narrowed,
 * and centring on a large screen is the whole of what was asked for.
 *
 * A maximum, so it is responsive by construction rather than by breakpoint: a phone, a narrow Bot
 * card and a 900px window are all under it and are not touched, and there is no width at which a
 * step appears.
 *
 * On the session view's own root rather than on the transcript, because everything inside that view
 * measures that column (see `SessionView`'s note): one cap on the root takes the rows, the sticky
 * headers over them and the composer under them together, where a cap on any one of them would
 * leave the others pointing at the old edges.
 */
export const SESSION_MEASURE_CLASS = "mx-auto w-full max-w-[48rem]";

/**
 * Whether a row of this role folds. A model's prose is the answer the reader came for, so it is
 * always open and carries no chevron; tool work, reasoning and the rest fold.
 */
export function isFoldableRole(role: DisplayRole): boolean {
  return role !== "assistant";
}

function LiveDot() {
  return (
    <span
      className="ml-[0.15em] inline-block size-[0.45em] shrink-0 animate-pulse rounded-full bg-primary motion-reduce:animate-none"
      style={{ animationIterationCount: 3 }}
      aria-hidden
    />
  );
}

/** Marks a prompt sent mid-turn that the session has not taken in yet. */
function QueuedChip() {
  return (
    <span className={CHIP_CLASS + "bg-muted text-muted-foreground"} title="Waiting for the turn in progress">
      queued
    </span>
  );
}

/**
 * An event's role chip and collapse toggle, floated so the first line of the
 * body sits beside it.
 *
 * This used to be a full-width bar above the body, which cost every event a
 * ~30px row carrying no content. Floating recovers that row for events whose
 * body starts with prose; bordered blocks clear the float (see
 * `isFlowBlock`) and so still begin below it.
 *
 * The event index and timestamp moved into `title` and the Raw drawer. They
 * were spending permanent width on two values nobody scans by eye, and the
 * drawer already holds every other per-event fact.
 *
 * It can also draw nothing: an expanded tool row has a chevron of its own on the call's header,
 * and a heading whose only content was a second one is not a heading. See `showChevron` below.
 */
export function EventHeading({
  ev,
  role,
  isCollapsed,
  onToggle,
  showCacheHits,
  isLive,
  showRole,
}: {
  ev: ActivityEvent;
  role: DisplayRole;
  isCollapsed: boolean;
  onToggle: () => void;
  showCacheHits: boolean;
  isLive: boolean;
  showRole: boolean;
}) {
  const when = ev.ts ? new Date(ev.ts).toLocaleTimeString() : null;
  const intent = role === "tool" ? toolIntent(ev) : null;
  const showIntent = !isCollapsed && intent !== null;
  const showCacheBadge = showCacheHits && ev.cacheHit !== undefined;
  // A prompt the session has not taken in yet says so where a streaming row shows its dot.
  const queued = ev.pending === "queued";
  /*
   * A tool call draws its own chevron on its own header, one line under this one, and to the eye
   * the two open the same thing. So an expanded tool row keeps ONE of them: this heading drops
   * its chevron, and what is left -- the role chip in raw mode, the intent above the call --
   * reads as the label it is rather than as a second control.
   *
   * Collapsed it keeps the chevron, because the call's own header is not on screen then and this
   * is the only way back into the row.
   */
  const showChevron = isFoldableRole(role) && (isCollapsed || role !== "tool");
  // And with the chevron gone there is often nothing left at all: a bare tool call in nice mode
  // has no chip and no intent. An empty heading is not free -- it is a focus stop, a hover target
  // and a float the first block has to clear -- so it is not drawn.
  if (!showChevron && !showRole && !isLive && !queued && !showCacheBadge && !showIntent) return null;
  // Nothing to open or close, so what is left is a label and not a control.
  if (!isFoldableRole(role)) {
    return (
      <div
        title={isLive ? "streaming" : when || undefined}
        // The live state is announced here, as it is on a foldable row's toggle.
        role={isLive ? "status" : undefined}
        aria-label={isLive ? "streaming" : undefined}
        className="float-left mt-[0.15em] mr-[0.4em] flex max-w-full items-center gap-[0.2em]"
      >
        {showRole ? <span className={CHIP_CLASS + ROLE_STYLES[role]}>{role}</span> : null}
        {isLive ? <LiveDot /> : null}
        {queued ? <QueuedChip /> : null}
        {showCacheBadge ? <CacheBadge cacheHit={ev.cacheHit!} /> : null}
      </div>
    );
  }
  // With nothing in front of it, the intent lines up with the call's name under it rather than
  // with that call's chevron: the header's chevron is `size-[1em]` and its gap `gap-1.5`
  // (ActivityBlockViews), so that is how far in the name starts.
  const intentLeads = !showChevron && !showRole && !isLive && !showCacheBadge;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={!isCollapsed}
      // The live state rides the label rather than a visible band, so it is
      // announced without spending a line. The pulse below is its sighted twin.
      aria-label={
        (isCollapsed ? "expand event" : "collapse event") + (isLive ? ", streaming" : "")
      }
      // The time alone: a transcript row's index is the byte its line starts at, an address rather
      // than a number a reader counts by (ADR-0124). A live row says what it is instead.
      title={isLive ? "streaming" : when || undefined}
      // `max-w-full` is what keeps a phone from scrolling sideways. A float is sized shrink-to-fit,
      // which floors at its min-content width, and the intent span below caps itself in `ch` --
      // an absolute bound that a 390px column cannot afford, so the float grew past the viewport
      // and took the whole transcript's horizontal scroll with it. Measured at 466px of content in
      // a 390px scroller; capped, 390.
      className="float-left mt-[0.15em] mr-[0.4em] flex max-w-full items-center gap-[0.2em] rounded-sm text-left transition-colors hover:bg-foreground/5"
    >
      {showChevron ? (
        <ChevronRight
          className={
            "size-[1em] shrink-0 text-muted-foreground transition-transform " +
            (isCollapsed ? "" : "rotate-90")
          }
          aria-hidden
        />
      ) : null}
      {showRole ? <span className={CHIP_CLASS + ROLE_STYLES[role]}>{role}</span> : null}
      {/* The ONLY thing a still-streaming row shows that a landed one does not.
          Inline and sub-chip sized, so when the transcript takes the message over
          and the dot goes away, one line loses a few pixels of width and nothing
          moves vertically. It pulses a few times as the row goes live and then holds
          solid: an infinite pulse kept the compositor drawing every frame for as long
          as the row was live, and a row whose message never finishes is live for good. */}
      {isLive ? <LiveDot /> : null}
      {queued ? <QueuedChip /> : null}
      {showCacheBadge ? <CacheBadge cacheHit={ev.cacheHit!} /> : null}
      {/* Why the tool ran, above the call that ran it. Only when expanded: a collapsed
          row already spends this space on its gist, and the heading is otherwise blank here. */}
      {showIntent ? (
        // Bounded, because this sits inside a float-left heading: an unbounded span would grow
        // the float to the width of a long description and push the body around it.
        <span
          className={
            (intentLeads ? "ml-[calc(1em+0.375rem)] " : "ml-[0.35em] ") +
            "max-w-[36ch] truncate font-sans text-muted-foreground"
          }
        >
          {intent}
        </span>
      ) : null}
    </button>
  );
}
