// The arena's shared visual words: what a harness is called, how a status reads, what a control
// looks like, and the clock a running lane counts on. One home, so the rail, the facts table and
// the lanes say "running" the same way.

import {
  ARENA_LIVE_STATUSES,
  type ArenaContestantSource,
  type ArenaContestantStatus,
  type ArenaRunMode,
} from "@agentdesk/agent-feed-wire";

export const SOURCE_LABEL: Record<ArenaContestantSource, string> = {
  opencode: "OpenCode",
  claude: "Claude",
};

/** The one-letter mark a harness wears where a whole name does not fit (the run list). */
export const SOURCE_INITIAL: Record<ArenaContestantSource, string> = {
  opencode: "O",
  claude: "C",
};

export const SOURCES = Object.keys(SOURCE_LABEL) as ArenaContestantSource[];

export const MODE_LABEL: Record<ArenaRunMode, string> = {
  terminals: "Terminals",
  headless: "Headless",
};

/** Whether a contestant is still somebody's live work, which is what keeps a clock ticking. */
export function isLive(contestant: { status: ArenaContestantStatus }): boolean {
  return ARENA_LIVE_STATUSES.includes(contestant.status);
}

/** The sidecar refuses more than this; the composer stops offering slots at the same number. */
export const MAXIMUM_CONTESTANTS = 4;

/** Type steps on the panel's own ladder, so the reader's font controls move the arena too. */
export const TEXT = {
  title: "text-(length:--agent-panel-fs-sidebar-title,15px)",
  body: "text-(length:--agent-panel-fs-sidebar-body,15px)",
  meta: "text-(length:--agent-panel-fs-sidebar-meta,13px)",
} as const;

const FOCUS = "outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background";

/** A bordered action: rest, hover, pressed, keyboard focus and disabled, all defined here. */
export const BUTTON =
  `inline-flex min-h-9 items-center justify-center gap-1.5 rounded-md border border-border bg-background px-3 ${TEXT.body} font-medium transition-colors duration-150 hover:bg-muted active:bg-accent disabled:pointer-events-none disabled:opacity-50 ${FOCUS}`;

/** The one filled action on a surface: starting a run. */
export const PRIMARY_BUTTON =
  `inline-flex min-h-9 items-center justify-center gap-2 rounded-md bg-primary px-4 ${TEXT.body} font-medium text-primary-foreground transition-opacity duration-150 hover:opacity-90 active:opacity-80 disabled:pointer-events-none disabled:opacity-40 ${FOCUS}`;

/** An icon-only action; its name rides `aria-label` and `title`, never a visible word. */
export const ICON_BUTTON =
  `inline-flex size-9 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground active:bg-accent disabled:pointer-events-none disabled:opacity-40 ${FOCUS}`;

export const FIELD =
  `w-full rounded-md border border-input bg-background px-3 py-2 ${TEXT.body} text-foreground placeholder:text-muted-foreground transition-colors focus-visible:border-ring ${FOCUS}`;

export { FOCUS };

const STATUS_WORD: Record<ArenaContestantStatus, string> = {
  preparing: "preparing",
  starting: "starting",
  ready: "ready",
  running: "running",
  closed: "closed",
  failed: "failed",
};

const STATUS_INK: Record<ArenaContestantStatus, string> = {
  preparing: "text-muted-foreground",
  starting: "text-muted-foreground",
  ready: "text-foreground",
  running: "text-arena-running",
  closed: "text-foreground",
  failed: "text-destructive",
};

/**
 * A status as a word with a mark in front: hollow while preparing or starting, filled once ready
 * and waiting at the start line, a pulsing dot while running (still under reduced motion), a
 * check once closed, a cross once failed. The word is always there, so a reader who cannot tell
 * the inks apart reads the same thing.
 */
export function StatusMark({ status, className = "" }: { status: ArenaContestantStatus; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 ${TEXT.meta} ${STATUS_INK[status]} ${className}`}>
      <StatusGlyph status={status} />
      {STATUS_WORD[status]}
    </span>
  );
}

export function StatusGlyph({ status }: { status: ArenaContestantStatus }) {
  if (status === "running") {
    return (
      <span aria-hidden className="relative inline-flex size-2">
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-arena-running opacity-60 motion-reduce:animate-none" />
        <span className="relative inline-flex size-2 rounded-full bg-arena-running" />
      </span>
    );
  }
  if (status === "closed") return <span aria-hidden>✓</span>;
  if (status === "failed") return <span aria-hidden>✕</span>;
  if (status === "ready") return <span aria-hidden className="inline-flex size-2 rounded-full bg-current" />;
  return <span aria-hidden className="inline-flex size-2 rounded-full border border-current" />;
}

