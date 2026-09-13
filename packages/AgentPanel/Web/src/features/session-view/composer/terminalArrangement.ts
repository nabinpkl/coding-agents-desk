/**
 * Which surfaces the composer band puts up for one session, given the arrangement it remembers.
 *
 * Its own module because it is the answer to a question asked in three places -- what is drawn,
 * whether the field is drawn, and what the control offers next -- and those drifted apart when the
 * answer was a boolean read three times. There are three arrangements now, and the interesting
 * property is that only ONE of them takes the field away.
 *
 * `echo` is the arrangement this was extracted for: the field AND a peek at the pane, so a reader
 * typing into a tmux-backed session can watch their own text arrive in the agent's composer line.
 * Showing both used to mean stacking two full-height input surfaces, which spent two thirds of the
 * band on input and left 267 of a card's 640 pixels for the transcript the two are about. A peek
 * is what makes both affordable: it opens at the minimum a pane can be rather than at the height
 * its screen wants, and the transcript keeps the difference.
 */
import type { TerminalComposerMode } from "@/features/terminal/terminalComposerPreference";

export interface TerminalArrangement {
  /** The pane's layout, or null when no pane is drawn. */
  pane: "band" | "echo" | null;
  /** Whether the composer's field is drawn. False for exactly one arrangement. */
  field: boolean;
}

/**
 * `hasBasis` is not a detail: a band pane cannot measure its own parent, so one mounted before its
 * height reference exists opens at a share of the VIEWPORT, which inside a card is more than the
 * whole card and squeezes the transcript away. No basis means no pane, and the field stays -- a
 * band with neither surface is one a reader cannot type into at all.
 */
export function terminalArrangement(
  mode: TerminalComposerMode,
  hasBasis: boolean,
): TerminalArrangement {
  if (!hasBasis || mode === "field") return { pane: null, field: true };
  return mode === "echo" ? { pane: "echo", field: true } : { pane: "band", field: false };
}
