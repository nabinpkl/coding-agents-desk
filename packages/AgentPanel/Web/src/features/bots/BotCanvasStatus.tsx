import { Monitor, Move, Scan } from "lucide-react";

/**
 * What the canvas is holding, above the roster that decides it.
 *
 * One block saying two halves of one fact: how many Bots are on the canvas, and which machines
 * they are on. They are the same number -- the chips' counts sum to the total over them -- so
 * putting them apart made a reader add up two rows to find that out, and cost the sidebar a
 * 112-pixel centred box to say a sentence of 13-pixel text.
 *
 * The machines exist because the canvas quietly acquired a second meaning. The picker in the tab
 * bar points the panel at one sidecar -- its session list, its terminals, its IDE, its desktop --
 * and the canvas stopped obeying it: a Bot is a directory and the sessions working in it, those
 * directories are not all on one machine, and showing them side by side is the whole point. So the
 * strip mixes machines while the bar above it names one, which reads as the bar being broken until
 * you know better. This is the half of that sentence the canvas owes the reader: here is what it
 * is showing, and here is how to narrow it.
 *
 * It is said from the SIDEBAR rather than from the strip, which is where it used to sit. The canvas
 * is a horizontal strip whose cards are as tall as their own rosters, so every row it spends on
 * chrome is a row the cards do not get -- and this is the same question the roster underneath it
 * already answers, which is which Bots are on the canvas and which are not.
 *
 * The chips are absent on a single-machine panel, which is every panel until a peer is declared: a
 * lone chip saying "dev" over a canvas of dev's Bots can only tell you what you already know,
 * and can only turn everything off. The count is not, because it is a fact about the canvas rather
 * than about the machines.
 *
 * Each count is on its chip rather than in a tooltip because it is the answer to the question a
 * hidden machine raises. A chip with nothing behind it and a chip holding back six cards look
 * identical otherwise, and the second is the one a reader is trying to find. That is also why a
 * hidden machine's Bots stay inside `total`: it counts what is ON the canvas, not what is on
 * screen, so pressing a chip never changes it.
 *
 * `shown` is the other one, and it exists because hiding a machine was otherwise invisible. The
 * strip simply came back one card short -- the choice is stored, so it survives a reload and comes
 * back days later -- and the only thing saying so was a chip going grey, in a sidebar that closes.
 * So the line says "7 of 8" rather than "8" while anything is held back, which puts the number
 * directly above the control that would bring it back. The canvas keeps its own height: it is a
 * horizontal strip whose cards are as tall as their rosters, and a band across it to say this
 * would cost every card a row.
 */
export function BotCanvasStatus({
  total,
  shown,
  machines,
  hidden,
  countOf,
  onToggle,
  zoom,
  room,
}: {
  /** Bots on the canvas, hidden machines included. The chips' counts sum to this. */
  total: number;
  /**
   * Of those, the ones a hidden machine is not holding back, which is the number of cards the
   * strip is actually drawing. Equal to `total` whenever nothing is hidden.
   */
  shown: number;
  /** Every machine, in the canvas's own order. Empty means one machine: no chips. */
  machines: readonly { key: string; label: string }[];
  hidden: ReadonlySet<string>;
  /** How many of the canvas's Bots are on that machine, shown or not. */
  countOf: (key: string) => number;
  onToggle: (key: string) => void;
  /**
   * The canvas drawn small enough to see all of, and the control that turns that on.
   *
   * It is here rather than on the canvas for the reason everything else in this block is: the
   * canvas is a horizontal strip whose cards are as tall as their own rosters, so every row it
   * spends on chrome is a row the cards do not get. The cost is real and worth saying -- with the
   * drawer closed on a phone, leaving the mode means opening the sidebar -- and it is bounded by
   * the gestures doing everything inside the mode, so this is only needed to enter and to leave.
   */
  zoom: { on: boolean; onToggle: () => void };
  /**
   * The gutter the fitted canvas is given to be scrolled around in, and the control for it.
   *
   * Asked for rather than always on, and that is the whole reason it is a control: room on an
   * axis that did not have any turns a canvas which only scrolled sideways into one that drifts
   * diagonally under a trackpad. Off, the canvas sits against the corner as it always has.
   *
   * It does nothing while the canvas is drawn at its own size -- the gutter belongs to the box
   * the mode draws into, and there is no such box at 1:1 -- so it is disabled there rather than
   * left to look like a control that does not work.
   */
  room: { on: boolean; onToggle: () => void };
}) {
  return (
    <div className="border-b border-border px-3 py-2">
      <p
        role="status"
        className="text-(length:--agent-panel-fs-sidebar-meta,13px) text-muted-foreground"
      >
        {`${shown < total ? `${shown} of ${total}` : total} ${total === 1 ? "bot" : "bots"} on the canvas`}
        {shown < total ? (
          // The consequence rather than the setting: a reader who does not remember pressing a
          // chip is looking for why a card is gone, and "3 hidden" is that sentence. Emphasised
          // because the rest of this line is a count nobody is reading.
          <span className="font-medium text-foreground">, {total - shown} hidden</span>
        ) : null}
      </p>
      {machines.length === 0 ? null : (
        <div
          role="group"
          aria-label="Machines on the canvas"
          className="mt-1.5 flex flex-wrap items-center gap-1.5"
        >
          <Monitor className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          {machines.map(({ key, label }) => {
            const on = !hidden.has(key);
            const count = countOf(key);
            return (
              <button
                key={key}
                type="button"
                aria-pressed={on}
                title={on
                  ? `Hide ${label}'s Bots from the canvas`
                  : `Show ${label}'s Bots on the canvas`}
                onClick={() => onToggle(key)}
                className={`flex min-h-7 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-(length:--agent-panel-fs-sidebar-chip,11px) font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary ${
                  on
                    ? "border-primary bg-primary/10 text-foreground hover:bg-primary/15"
                    : "border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground active:bg-muted/80"
                }`}
              >
                {label}
                <span className="tabular-nums opacity-70">{count}</span>
              </button>
            );
          })}
        </div>
      )}
      <button
        type="button"
        aria-pressed={zoom.on}
        onClick={zoom.onToggle}
        title={zoom.on
          ? "Draw the canvas at its own size again"
          : "Draw the whole canvas at once. Pinch or double-tap to move around it."}
        className={`mt-1.5 flex min-h-7 w-full cursor-pointer items-center gap-1.5 rounded-md border px-2.5 text-(length:--agent-panel-fs-sidebar-chip,11px) font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary ${
          zoom.on
            ? "border-primary bg-primary/10 text-foreground hover:bg-primary/15 active:bg-primary/20"
            : "border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground active:bg-muted/80"
        }`}
      >
        <Scan className="size-3.5 shrink-0" aria-hidden />
        Fit the whole canvas
      </button>
      <button
        type="button"
        aria-pressed={room.on}
        disabled={!zoom.on}
        onClick={room.onToggle}
        title={zoom.on
          ? room.on
            ? "Take the room back out, so the canvas sits against the corner."
            : "Add room around the canvas, so it can be scrolled off the corner."
          : "Fit the whole canvas first: the room is around what that draws."}
        className={`mt-1.5 flex min-h-7 w-full items-center gap-1.5 rounded-md border px-2.5 text-(length:--agent-panel-fs-sidebar-chip,11px) font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary ${
          !zoom.on
            ? "cursor-not-allowed border-border bg-card text-muted-foreground/50"
            : room.on
              ? "cursor-pointer border-primary bg-primary/10 text-foreground hover:bg-primary/15 active:bg-primary/20"
              : "cursor-pointer border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground active:bg-muted/80"
        }`}
      >
        <Move className="size-3.5 shrink-0" aria-hidden />
        Room to move it
      </button>
    </div>
  );
}
