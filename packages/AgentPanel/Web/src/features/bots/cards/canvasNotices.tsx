// What the canvas says instead of drawing cards, and what it says above the ones it is drawing.
//
// Split out of `BotCanvas.tsx` because it is a different concern from the strip: the placeholder
// REPLACES the canvas when there is nothing to lay out, the bands sit ABOVE it and are about what
// the canvas is not showing, and neither has anything to do with how cards are sized, ordered or
// carried. What was left behind is the strip itself.
//
// It sits under `cards/` rather than beside `BotCanvas.tsx`, and that half is the twelve-file
// ceiling rather than the concept: `features/bots/` has one slot left and the canvas's zoom hook
// takes it. Said plainly rather than dressed up. The concept is not a stretch either -- the first
// of these, `CanvasNotice`, already lived in `BotCanvasCard.tsx`, which is the file in this
// directory that is least about a card.

import { Bot, LoaderCircle, Plus } from "lucide-react";
import type { MachineError } from "@/features/bots/useBots";

export function CanvasNotice({ children }: { children: React.ReactNode }) {
  return (
    <div
      role="status"
      className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center text-(length:--agent-panel-fs-sidebar-body,15px) text-muted-foreground"
    >
      {children}
    </div>
  );
}

/**
 * The canvas when it has no cards to draw: still arriving, unreadable, or genuinely empty.
 *
 * All three replace the strip rather than sitting over it, which is why they are one component and
 * why the caller returns it instead of rendering it: there is no scroller, no strip and nothing to
 * scroll to, so everything the canvas does below this point would be about nothing.
 */
export function CanvasPlaceholder({
  loading,
  error,
  detachedCount,
  onAddBot,
}: {
  loading: boolean;
  error: string | null;
  /**
   * How many Bots exist but are off the canvas, which is only ever asked when there are no cards.
   * An empty canvas that says "No bots yet" over a roster of eight is a lie, and would send the
   * reader to Add Bot rather than to the roster their Bots are already in.
   */
  detachedCount: number;
  onAddBot: () => void;
}) {
  if (loading) {
    return (
      <CanvasNotice>
        <LoaderCircle className="size-4 animate-spin" aria-hidden />
        Loading Bots…
      </CanvasNotice>
    );
  }
  if (error) {
    return (
      <div
        role="alert"
        className="flex h-full items-center justify-center p-8 text-center text-(length:--agent-panel-fs-sidebar-body,15px) text-destructive"
      >
        Bots unavailable: {error}
      </div>
    );
  }
  return (
    <CanvasNotice>
      <Bot className="size-5" aria-hidden />
      <span>
        {detachedCount > 0
          ? "No Bots on the canvas. Put one on from the roster in the sidebar."
          : "No bots yet"}
      </span>
      <button
        type="button"
        onClick={onAddBot}
        className="mt-1 flex min-h-9 cursor-pointer items-center gap-2 rounded-lg border border-border px-3 text-(length:--agent-panel-fs-sidebar-meta,13px) font-medium text-primary outline-none transition-colors hover:bg-primary/10 focus-visible:ring-2 focus-visible:ring-primary active:bg-primary/15"
      >
        <Plus className="size-4" aria-hidden />
        Add Bot
      </button>
    </CanvasNotice>
  );
}

/** One band, so the three below cannot drift apart in the one thing they share, which is shape. */
function Band({ alert, children }: { alert?: boolean; children: React.ReactNode }) {
  return (
    <div
      role={alert ? "alert" : "status"}
      className={`mx-3 mt-3 rounded-lg border px-3 py-2 text-(length:--agent-panel-fs-sidebar-meta,13px) ${
        alert
          ? "border-destructive/40 bg-destructive/10 text-destructive"
          : "border-border bg-muted/60 text-muted-foreground"
      }`}
    >
      {children}
    </div>
  );
}

/**
 * What the canvas owes the reader about what it is NOT showing, above the cards it is.
 *
 * Every one of these is about the canvas as a whole rather than about any card, which is why they
 * render OUTSIDE anything the zoom mode scales: a warning drawn at a third of its size is one
 * nobody reads, and the thing it is warning about is exactly a canvas you cannot see all of.
 */
export function CanvasNotices({
  machineErrors,
  onCanvas,
  drawn,
  orphanedError,
}: {
  /**
   * Machines that cannot be read, while others can.
   *
   * Said rather than swallowed: a declared peer that is unreachable looks exactly like a peer with
   * no Bots on it, so an empty strip where a machine's cards used to be is the one failure on this
   * surface that reports itself as success. One whose last snapshot is still drawn is said to be
   * reconnecting instead, because its cards are on the canvas and saying otherwise is untrue.
   */
  machineErrors: readonly MachineError[];
  /** Bots on the canvas at all, hidden machines included. */
  onCanvas: number;
  /** Of those, the ones the strip is actually drawing. */
  drawn: number;
  /** A failure no card can carry, because it is about no session or about one not on the canvas. */
  orphanedError: string | null;
}) {
  return (
    <>
      {machineErrors.map(({ label, reason, held }) =>
        held ? (
          <Band key={label}>Reconnecting to {label}. Its Bots are shown as they last were.</Band>
        ) : (
          <Band key={label}>
            {label} is not answering, so its Bots are not on the canvas: {reason}
          </Band>
        ),
      )}
      {/* A canvas emptied by the machine chips rather than by having no Bots. Without this the
          strip is simply blank, and the two look identical to a reader who has forgotten pressing
          one. */}
      {drawn === 0 && onCanvas > 0 ? (
        <Band>
          {onCanvas} {onCanvas === 1 ? "Bot is" : "Bots are"} on machines you have hidden. The
          machines are in the sidebar's Canvas roster, above the Bots.
        </Band>
      ) : null}
      {orphanedError ? <Band alert>{orphanedError}</Band> : null}
    </>
  );
}
