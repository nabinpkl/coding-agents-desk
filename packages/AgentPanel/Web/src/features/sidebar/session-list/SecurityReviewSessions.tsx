"use client";

// Security reviews, folded into one row at the bottom of whichever list they are in.
//
// The `security-guidance` plugin reviews every commit and every stopped turn in a session of its
// own, so in a busy repository these outnumber the reader's sessions several to one. They are
// still sessions -- one can be opened, read and archived like any other -- so they are folded
// rather than hidden. The sidecar names them (`SessionSummary.automation`); nothing here guesses
// from a title, which a person's own review session can share.
//
// Folded by default and not remembered, like the Archived row: a reload that came back folded
// costs one click, and the fold is there so the list leads with the reader's own work.

import { ChevronDown, ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";
import type { SessionSummary } from "@agentdesk/agent-feed-wire";
import { ActivityDot } from "@/features/sidebar/session-list/SessionMeta";

/** A project's sessions, with its security reviews taken out into their own list. */
export function splitSecurityReviews(sessions: readonly SessionSummary[]): {
  sessions: SessionSummary[];
  reviews: SessionSummary[];
} {
  const own: SessionSummary[] = [];
  const reviews: SessionSummary[] = [];
  for (const session of sessions) {
    (session.automation === "security-review" ? reviews : own).push(session);
  }
  return { sessions: own, reviews };
}

export function SecurityReviewFold({
  count,
  live,
  open,
  onToggle,
  inset,
  children,
}: {
  count: number;
  /** How many are running now, which is what a folded row would otherwise hide. */
  live: number;
  open: boolean;
  onToggle: () => void;
  /** Under a project heading, where rows sit indented, rather than in the flat list. */
  inset: boolean;
  /** The rows, drawn only while it is open. */
  children: ReactNode;
}) {
  if (count === 0) return null;
  return (
    <div className="border-t border-border/60 pb-1">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className={`flex min-h-10 w-full cursor-pointer items-center gap-1.5 pr-3 text-left text-(length:--agent-panel-fs-sidebar-meta,13px) font-medium text-muted-foreground outline-none hover:bg-muted/60 hover:text-foreground focus-visible:bg-muted/60 focus-visible:text-foreground active:bg-muted/80 ${
          inset ? "pl-8" : "pl-3"
        }`}
      >
        <ChevronDown className={`size-3.5 shrink-0 transition-transform ${open ? "" : "-rotate-90"}`} aria-hidden />
        <ShieldCheck className="size-3.5 shrink-0" aria-hidden />
        <span className="min-w-0 flex-1 truncate">Security reviews ({count})</span>
        {live > 0 ? (
          <span className="flex shrink-0 items-center gap-1.5 tabular-nums">
            <ActivityDot activity="live" />
            {live} running
          </span>
        ) : null}
      </button>
      {open ? children : null}
    </div>
  );
}
