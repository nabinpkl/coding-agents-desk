// What the terminal strip is holding, above the roster that decides it.
//
// The Bot canvas's `BotCanvasStatus` with the Bot taken out: how many parents stand on the strip,
// and the two controls that need no row of the strip's own -- drawing the whole strip at once,
// and how much room that drawing gets to be scrolled around in. It lives in the roster beside
// the strip rather than on the strip, because a strip of cards as tall as their own rosters has
// no row to spare for chrome.
import { Move, Scan } from "lucide-react";
import { CANVAS_ROOM_STEPS } from "@/features/bots/canvas/botCanvasPreferences";

export function TerminalCanvasStatus({
  total,
  shown,
  zoom,
  room,
}: {
  /** Parents standing on the strip's machines, whether or not they are drawn. */
  total: number;
  /** Of those, the ones actually drawn -- no machine hiding them, no reader hiding. */
  shown: number;
  /** The strip drawn small enough to see all of, and the control that turns that on. */
  zoom: { on: boolean; onToggle: () => void };
  /** How much room the fitted strip gets to be scrolled around in, and its control. */
  room: { size: number; onChange: (size: number) => void };
}) {
  return (
    <div className="border-b border-border px-3 py-2">
      <p role="status" className="text-(length:--agent-panel-fs-sidebar-meta,13px) text-muted-foreground">
        {`${shown < total ? `${shown} of ${total}` : total} ${total === 1 ? "parent" : "parents"} on the strip`}
        {shown < total ? <span className="font-medium text-foreground">, {total - shown} hidden</span> : null}
      </p>
      <button
        type="button"
        aria-pressed={zoom.on}
        onClick={zoom.onToggle}
        title={
          zoom.on ? "Draw the strip at its own size again" : "Draw the whole strip at once. Pinch to zoom in and out."
        }
        className={`mt-1.5 flex min-h-7 w-full cursor-pointer items-center gap-1.5 rounded-md border px-2.5 text-(length:--agent-panel-fs-sidebar-chip,11px) font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary ${
          zoom.on
            ? "border-primary bg-primary/10 text-foreground hover:bg-primary/15 active:bg-primary/20"
            : "border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground active:bg-muted/80"
        }`}
      >
        <Scan className="size-3.5 shrink-0" aria-hidden />
        Fit the whole strip
      </button>
      <div role="group" aria-label="Room to move the strip" className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <Move
          className={`size-3.5 shrink-0 ${zoom.on ? "text-muted-foreground" : "text-muted-foreground/40"}`}
          aria-hidden
        />
        {CANVAS_ROOM_STEPS.map((size) => (
          <button
            key={size}
            type="button"
            aria-pressed={room.size === size}
            disabled={!zoom.on}
            title={
              !zoom.on
                ? "Fit the whole strip first: the room is around what that draws."
                : size === 0
                  ? "No room: the strip sits against the corner."
                  : `${size} pixels of room on every side, to scroll the strip into.`
            }
            onClick={() => room.onChange(size)}
            className={`flex min-h-7 shrink-0 items-center rounded-full border px-2.5 text-(length:--agent-panel-fs-sidebar-chip,11px) font-medium tabular-nums outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary ${
              !zoom.on
                ? "cursor-not-allowed border-border bg-card text-muted-foreground/40"
                : room.size === size
                  ? "cursor-pointer border-primary bg-primary/10 text-foreground hover:bg-primary/15 active:bg-primary/20"
                  : "cursor-pointer border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground active:bg-muted/80"
            }`}
          >
            {size === 0 ? "None" : size}
          </button>
        ))}
      </div>
    </div>
  );
}
