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
 * It says that from the SIDEBAR's canvas roster rather than from the strip itself, which is where it
 * used to sit. The canvas is a horizontal strip whose cards are as tall as their own rosters, so
 * every row it spends on chrome is a row the cards do not get -- and this row is about the same
 * thing the roster beside it already is, which is which Bots are on the canvas and which are not.
 * The Bots are listed there, the machine counts are listed here, and the strip is left to the cards.
 *
 * Rendered only when there is more than one machine, which is every panel until a peer is declared.
 * A single chip saying "dev" over a canvas of dev's Bots is a control that can only tell you
 * what you already know, and one that can only turn everything off.
 *
 * The count is on the chip rather than in a tooltip because it is the answer to the question a
 * hidden machine raises. A chip with nothing behind it and a chip holding back six cards look
 * identical otherwise, and the second is the one a reader is trying to find. The counts add up to
 * the Bot count under them, because both count what is on the canvas rather than what is on screen.
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
      className="flex flex-wrap items-center gap-1.5 border-b border-border px-3 py-2"
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
