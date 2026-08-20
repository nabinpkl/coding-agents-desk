"use client";

import { LoaderCircle, ScrollText } from "lucide-react";
import type { SummaryState } from "./useSummary";

/**
 * The Summarize button, beside the terminal control in the thread header.
 *
 * One label in every state. An earlier design flipped it to "Arm" while a turn was running and
 * "Summarize" after; the two do the same thing to the same window, so the flip was describing
 * the session rather than the action, and `phase` on the result says that better.
 */
export function SummaryControl({
  state,
  running,
  onSummarize,
}: {
  state: SummaryState;
  /** Whether the watched turn is still in flight, which changes the tooltip, not the action. */
  running: boolean;
  onSummarize: () => void;
}) {
  const pending = state.kind === "pending";
  const label = running ? "Summarize what it is doing" : "Summarize this turn";
  return (
    <button
      type="button"
      onClick={onSummarize}
      disabled={pending}
      aria-label={label}
      aria-busy={pending}
      title={label}
      className={
        "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors "
        + "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary "
        + "disabled:cursor-progress disabled:opacity-60 "
        + (state.kind === "ready"
          ? "bg-primary/20 text-primary hover:bg-primary/30"
          : "text-muted-foreground hover:bg-muted hover:text-foreground active:bg-muted/80")
      }
    >
      {pending
        ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden />
        : <ScrollText className="h-4 w-4" aria-hidden />}
    </button>
  );
}
