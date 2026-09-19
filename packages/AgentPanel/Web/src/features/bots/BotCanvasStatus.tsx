import { Monitor } from "lucide-react";

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
 * hidden machine's Bots stay inside `total`: both numbers count what is ON the canvas, not what is
 * on screen, so pressing a chip never changes either of them.
 */
export function BotCanvasStatus({
  total,
  machines,
  hidden,
  countOf,
  onToggle,
}: {
  /** Bots on the canvas, hidden machines included. The chips' counts sum to this. */
  total: number;
  /** Every machine, in the canvas's own order. Empty means one machine: no chips. */
  machines: readonly { key: string; label: string }[];
  hidden: ReadonlySet<string>;
  /** How many of the canvas's Bots are on that machine, shown or not. */
  countOf: (key: string) => number;
  onToggle: (key: string) => void;
}) {
  return (
    <div className="border-b border-border px-3 py-2">
      <p
        role="status"
        className="text-(length:--agent-panel-fs-sidebar-meta,13px) text-muted-foreground"
      >
        {total} {total === 1 ? "bot" : "bots"} on the canvas
      </p>
      {machines.length === 0 ? null : (
        <div
          role="group"
          aria-label="Machines on the canvas"
          className="mt-1.5 flex flex-wrap items-center gap-1.5"
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
      )}
    </div>
  );
}
