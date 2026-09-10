"use client";

// The chip at the head of an event: which role it is, whether it is collapsed, and the
// prompt-cache badge that rides beside it.
//
// Split from the rows because the float, the clearance and the chip's own leading are a
// typographic argument with measurements in it, and nothing about which rows exist.

import { ChevronDown, ChevronRight } from "lucide-react";
import type { ActivityEvent, EventCacheHit } from "@/features/activity-feed/useSessionEventsStream";
import { displayRole, type DisplayRole } from "@/features/activity-feed/rows/activityDisplayItems";
import { eventPreview, toolIntent } from "@/features/activity-feed/rows/activityEventText";
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

/** Nice keeps operational roles, but lets model prose and reasoning read as one response. */
export function showEventRoleLabel(
  mode: SessionReference["mode"],
  role: DisplayRole,
): boolean {
  return mode === "raw" || (role !== "assistant" && role !== "reasoning");
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
export const FEED_ROW_GUTTER_CLASS = "px-6";

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
      // A live row has no transcript position yet, so it says what it is instead
      // of naming an index that would read as `#-1`.
      title={isLive ? "streaming" : when ? `#${ev.index} · ${when}` : `#${ev.index}`}
      // `max-w-full` is what keeps a phone from scrolling sideways. A float is sized shrink-to-fit,
      // which floors at its min-content width, and the intent span below caps itself in `ch` --
      // an absolute bound that a 390px column cannot afford, so the float grew past the viewport
      // and took the whole transcript's horizontal scroll with it. Measured at 466px of content in
      // a 390px scroller; capped, 390.
      className="float-left mt-[0.15em] mr-[0.4em] flex max-w-full items-center gap-[0.2em] rounded-sm text-left transition-colors hover:bg-foreground/5"
    >
      <ChevronRight
        className={
          "size-[1em] shrink-0 text-muted-foreground transition-transform " +
          (isCollapsed ? "" : "rotate-90")
        }
        aria-hidden
      />
      {showRole ? <span className={CHIP_CLASS + ROLE_STYLES[role]}>{role}</span> : null}
      {/* The ONLY thing a still-streaming row shows that a landed one does not.
          Inline and sub-chip sized, so when the transcript takes the message over
          and the dot goes away, one line loses a few pixels of width and nothing
          moves vertically. */}
      {isLive ? (
        <span
          className="ml-[0.15em] inline-block size-[0.45em] shrink-0 animate-pulse rounded-full bg-primary"
          aria-hidden
        />
      ) : null}
      {showCacheHits && ev.cacheHit ? <CacheBadge cacheHit={ev.cacheHit} /> : null}
      {/* Why the tool ran, beside the chip that says a tool ran. Only when expanded: a collapsed
          row already spends this space on its gist, and the heading is otherwise blank here. */}
      {!isCollapsed && intent ? (
        // Bounded, because this sits inside a float-left heading: an unbounded span would grow
        // the float to the width of a long description and push the body around it.
        <span className="ml-[0.35em] max-w-[36ch] truncate font-sans text-muted-foreground">
          {intent}
        </span>
      ) : null}
    </button>
  );
}
