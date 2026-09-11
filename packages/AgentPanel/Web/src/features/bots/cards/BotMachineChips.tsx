import { Monitor } from "lucide-react";

/**
 * Which machines the canvas is showing, and the one control that changes it.
 *
 * It exists because the canvas quietly acquired a second meaning. The picker in the tab bar points
 * the panel at one sidecar -- its session list, its terminals, its IDE, its desktop -- and the
 * canvas stopped obeying it: a Bot is a directory and the sessions working in it, those directories
 * are not all on one machine, and showing them side by side is the whole point. So the strip mixes
 * machines while the bar above it names one, which reads as the bar being broken until you know
 * better. This is the half of that sentence the canvas owes the reader: here is what it is showing,
 * and here is how to narrow it.
 *
 * Rendered only when there is more than one machine, which is every panel until a peer is declared.
 * A single chip saying "dev" over a canvas of dev's Bots is a control that can only tell you
 * what you already know, and one that can only turn everything off.
 *
 * The count is on the chip rather than in a tooltip because it is the answer to the question a
 * hidden machine raises. A chip with nothing behind it and a chip holding back six cards look
 * identical otherwise, and the second is the one a reader is trying to find.
 */
export function BotMachineChips({
  machines,
  hidden,
  countOf,
  onToggle,
}: {
  /** Every machine, in the canvas's own order. Empty means one machine: nothing renders. */
  machines: readonly { key: string; label: string }[];
  hidden: ReadonlySet<string>;
  /** How many of the canvas's Bots are on that machine, shown or not. */
  countOf: (key: string) => number;
  onToggle: (key: string) => void;
}) {
  if (machines.length === 0) return null;
  return (
    <div
      role="group"
      aria-label="Machines on the canvas"
      // Sticky to the scroller's top-left rather than scrolling away with the strip: the canvas
      // scrolls sideways for as long as the roster is wide, and a control that leaves with the
      // first card is one a reader has to scroll back for to answer "where did those go".
      className="sticky top-0 left-0 z-20 flex w-max flex-wrap items-center gap-1.5 px-3 pt-3"
    >
      <Monitor className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      {machines.map(({ key, label }) => {
        const shown = !hidden.has(key);
        const count = countOf(key);
        return (
          <button
            key={key}
            type="button"
            aria-pressed={shown}
            title={shown
              ? `Hide ${label}'s Bots from the canvas`
              : `Show ${label}'s Bots on the canvas`}
            onClick={() => onToggle(key)}
            className={`flex min-h-7 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-(length:--agent-panel-fs-sidebar-chip,11px) font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary ${
              shown
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
  );
}
