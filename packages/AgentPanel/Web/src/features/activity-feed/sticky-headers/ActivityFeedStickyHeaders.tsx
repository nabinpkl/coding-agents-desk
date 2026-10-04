"use client";

// The two bars pinned over the top of the transcript: the user message the reader
// scrolled past, and the event they are inside now.

import type { RefObject } from "react";
import { ChevronRight } from "lucide-react";
import type { ActivityEvent } from "@/features/activity-feed/useSessionEventsStream";
import type { EventMode } from "@/features/activity-feed/data-source/AgentDataSource";
import { eventPreview } from "@/features/activity-feed/rows/activityEventText";
import { displayRole, leadEvent, type DisplayItem, type DisplayRole } from "@/features/activity-feed/rows/activityDisplayItems";
import { ROLE_BORDER, ROLE_STYLES, showEventRoleLabel } from "@/features/activity-feed/blocks/ActivityEventHeading";
import { COLUMN_GUTTER_CLASS } from "@/features/activity-feed/blocks/ActivityEventHeading";

/** The prose of a person's message, which is what the user bar shows of it. */
export function userMessageText(ev: ActivityEvent): string {
  // Deliberately not `eventPreview`: this bar stands for a person's message, so
  // it reaches past any leading tool_result for the prose they actually typed.
  // `eventPreview` takes whichever content block comes first, which is right for
  // an agent row and wrong here.
  return ev.blocks.find((b) => b.kind === "text")?.text ?? "";
}

// Compact pinned header for the most recent USER event the viewer scrolled
// past. Full-width opaque strip flush with the top of the scroll area, so
// rows scroll cleanly under it without the canvas pattern bleeding through.
// Click to jump back to the original message (and break sticky-bottom so the
// jump actually holds instead of snapping to the live tail).
export function StickyUserHeader({
  text, onClick, buttonRef,
}: {
  // No row number: a transcript row is named by the byte its line starts at (ADR-0124), which is
  // an address and not something a reader counts by.
  text: string;
  onClick: () => void;
  buttonRef: React.RefObject<HTMLButtonElement | null>;
}) {
  const preview = text.split("\n")[0]!.trim().slice(0, 200);
  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={onClick}
      title="jump to message"
      className={`flex w-full items-center gap-2 border-b session-view-dock ${COLUMN_GUTTER_CLASS} py-2 text-left shadow-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary`}
      style={{ fontSize: "var(--agent-panel-fs-tile-other-text, 16px)" }}
    >
      <span className="shrink-0 rounded-md bg-primary/30 px-1.5 py-0.5 font-mono text-(length:--agent-panel-fs-tile-chip,12px) font-semibold uppercase tracking-wider text-primary">
        user
      </span>
      <span className="min-w-0 flex-1 truncate leading-snug text-foreground">
        {preview || "(no text)"}
      </span>
    </button>
  );
}

// Secondary sticky for the event row currently being scrolled through. Sits
// directly below the primary user sticky and reflects the most recent row
// whose heading has scrolled behind the bar while its content is still on
// screen. Click jumps to that row's start.
export function StickyEventHeader({
  item, mode, onClick,
}: {
  item: DisplayItem;
  mode: EventMode;
  onClick: () => void;
}) {
  const ev = leadEvent(item);
  // A folded run is tool work by construction, so it names itself `tool` rather than
  // taking the role of whichever of its members happens to be first.
  const role: DisplayRole =
    item.kind === "user" ? "user" : item.kind === "cluster" ? "tool" : displayRole(ev);
  return (
    <button
      type="button"
      onClick={onClick}
      title="jump to event start"
      className={
        `flex w-full items-center gap-[0.4em] border-b border-l-[3px] session-view-dock ${COLUMN_GUTTER_CLASS} py-1.5 text-left shadow-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary ` +
        ROLE_BORDER[role]
      }
      style={{ fontSize: "var(--agent-panel-fs-tile-other-text, 16px)" }}
    >
      <ChevronRight
        className="size-[1.1em] shrink-0 rotate-90 text-muted-foreground"
        aria-hidden
      />
      {showEventRoleLabel(mode, role) ? (
        <span
          className={
            "shrink-0 rounded-sm px-[0.4em] py-[0.1em] font-mono text-(length:--agent-panel-fs-tile-chip,12px) font-bold uppercase tracking-wider " +
            ROLE_STYLES[role]
          }
        >
          {role}
        </span>
      ) : null}
      <span className="min-w-0 flex-1 truncate text-muted-foreground">
        {eventPreview(ev)}
      </span>
    </button>
  );
}
