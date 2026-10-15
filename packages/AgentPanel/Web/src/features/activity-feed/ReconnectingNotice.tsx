import { LoaderCircle } from "lucide-react";

/**
 * The one "reconnecting" chip, for every surface that keeps showing what it had while its stream
 * comes back: a session card's transcript and the sidebar's Sessions list. One look for one fact, so
 * a reader who has seen it once knows it everywhere. Raised and coloured on purpose: it appears for
 * a second or two during a sidecar restart, and a muted chip that size went unnoticed.
 */
export function ReconnectingChip() {
  return (
    <span
      className="flex items-center gap-2 rounded-full border border-amber-500/50 bg-card px-4 py-1.5 font-medium text-foreground shadow-lg shadow-black/25 ring-1 ring-black/5"
      style={{ fontSize: "var(--agent-panel-fs-sidebar-body, 15px)" }}
    >
      <LoaderCircle className="size-[1.1em] animate-spin text-amber-500 motion-reduce:animate-none" aria-hidden />
      Reconnecting…
    </span>
  );
}

/**
 * A thread whose stream dropped, said on the thread itself.
 *
 * Its rows stay where they are, which is the point -- a sidecar restart drops every stream and the
 * card should ride through it -- but rows that stay look exactly like rows that are live, so
 * without this a card sat still through a restart with nothing to say it had stopped following.
 * It goes the moment the stream opens again. At the bottom, just above the composer, because that
 * is where the newest rows land and where the reader is looking to see whether the agent moved. An
 * overlay rather than a row for the reason the compaction notice gives: there is no event behind it.
 */
export function ReconnectingNotice() {
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-4 z-30 flex justify-center" role="status" aria-live="polite">
      <ReconnectingChip />
    </div>
  );
}
