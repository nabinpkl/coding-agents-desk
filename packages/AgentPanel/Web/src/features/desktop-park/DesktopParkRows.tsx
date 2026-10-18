"use client";

import { ArrowLeftToLine, ArrowRightToLine } from "lucide-react";
import type { ParkMove, ParkWindow } from "@agentdesk/agent-feed-wire";
import type { DesktopParkHandle } from "@/features/desktop-park/useDesktopPark";

export function WindowRow({
  window: w,
  move,
  watching,
  onWatch,
}: {
  window: ParkWindow;
  move: ParkMove | undefined;
  watching: boolean;
  onWatch: () => void;
}) {
  const leaving = move && !move.noop;
  return (
    <li
      className={`flex items-baseline gap-2 border-b border-border/50 px-3 py-1.5 text-sm
      last:border-b-0 ${watching ? "bg-accent/40" : ""}`}
    >
      <button
        type="button"
        onClick={onWatch}
        aria-pressed={watching}
        title={watching ? "Stop watching this window" : "Watch this window live"}
        className="w-20 shrink-0 truncate rounded text-left text-xs text-muted-foreground
          transition-colors hover:text-foreground focus-visible:outline-2
          focus-visible:-outline-offset-2 focus-visible:outline-primary"
      >
        {w.app}
      </button>
      <span className="min-w-0 flex-1 truncate" title={w.title}>
        {w.title || <span className="text-muted-foreground">untitled</span>}
      </span>
      <span className="hidden shrink-0 font-mono text-[11px] text-muted-foreground sm:inline">
        {w.frame.w}×{w.frame.h}
      </span>
      {move ? (
        <span
          className={`flex shrink-0 items-center gap-1 font-mono text-[11px]
            ${leaving ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"}`}
          title={`rung ${move.rung}, depth ${move.depth}, ${move.exposedPt2}pt² would stay uncovered`}
        >
          {move.side === "left" ? (
            <ArrowLeftToLine className="size-3" aria-hidden />
          ) : (
            <ArrowRightToLine className="size-3" aria-hidden />
          )}
          {move.to.x},{move.to.y}
        </span>
      ) : (
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground">no room</span>
      )}
      <span className="w-8 shrink-0 text-right font-mono text-[11px] text-muted-foreground">#{w.id % 100000}</span>
    </li>
  );
}

export function Outcome({ action }: { action: DesktopParkHandle["action"] }) {
  if (action.kind === "none" || action.kind === "running") return null;
  if (action.kind === "failed") {
    return (
      <p
        className="shrink-0 border-b border-destructive/40 bg-destructive/10 px-3 py-2 text-xs
        text-destructive"
      >
        {action.what === "park" ? "Park" : "Restore"} failed: {action.message}
      </p>
    );
  }
  if (action.kind === "parked") {
    const { report } = action;
    const failed = [...report.gathered, ...report.laid].filter((step) => !step.ok);
    const reordered = report.orderBeforeGather.join(",") !== report.observedOrder.join(",");
    return (
      <p
        className="shrink-0 border-b border-border bg-muted/40 px-3 py-2 font-mono text-[11px]
        text-muted-foreground"
      >
        parked {report.candidates} onto Desktop {report.targetSpace.index}
        {reordered ? " · stacking order changed during the gather, ladder used the new one" : ""}
        {failed.length > 0 ? ` · ${failed.length} step(s) failed` : ""}
      </p>
    );
  }
  const { report } = action;
  const counts = report.results.reduce<Record<string, number>>((acc, r) => {
    acc[r.outcome] = (acc[r.outcome] ?? 0) + 1;
    return acc;
  }, {});
  return (
    <p
      className="shrink-0 border-b border-border bg-muted/40 px-3 py-2 font-mono text-[11px]
      text-muted-foreground"
    >
      {report.found
        ? Object.entries(counts)
            .map(([k, n]) => `${n} ${k}`)
            .join(" · ") || "nothing to restore"
        : "no park manifest on disk"}
      {report.manifestCleared ? " · manifest cleared" : ""}
    </p>
  );
}

export function Action({
  onClick,
  label,
  disabled,
  busy,
  tone,
  icon,
}: {
  onClick: () => void;
  label: string;
  disabled: boolean;
  busy: boolean;
  tone: "primary" | "ghost";
  icon?: React.ReactNode;
}) {
  const base =
    "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors " +
    "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary " +
    "disabled:cursor-not-allowed disabled:opacity-50";
  const skin =
    tone === "primary"
      ? "bg-primary text-primary-foreground hover:bg-primary/90 active:bg-primary/80 disabled:hover:bg-primary"
      : "border border-border text-foreground hover:bg-muted active:bg-muted/70 disabled:hover:bg-transparent";
  return (
    <button type="button" onClick={onClick} disabled={disabled} className={`${base} ${skin}`}>
      {busy ? (
        <span
          className="size-3 animate-spin rounded-full border-2 border-current border-t-transparent
            motion-reduce:animate-none"
          aria-hidden
        />
      ) : (
        icon
      )}
      {busy ? "Working…" : label}
    </button>
  );
}
