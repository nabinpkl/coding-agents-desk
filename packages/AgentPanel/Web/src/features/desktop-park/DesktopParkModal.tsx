"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeftToLine, ArrowRightToLine, MousePointer2, RotateCcw, X } from "lucide-react";
import type { ParkMove, ParkStateResponse, ParkWindow } from "@agentdesk/agent-feed-wire";
import type { DesktopStreamState } from "../desktop-viewer/DesktopStreamState";
import { TileStreamRtc, type PointerInputTransport } from "../desktop-viewer/TileStreamRtc";
import { TileViewport } from "../desktop-viewer/TileViewport";
import { TileStream } from "./TileStream";
import type { DesktopParkHandle } from "./useDesktopPark";

/**
 * Desktop Park: every window this machine could gather onto one Desktop, grouped
 * by the Desktop it is on now, with what a park would do to each.
 *
 * A scrolling list rather than a canvas, deliberately. The spatial view is a
 * later thing; what this has to answer first is "what would it move, where to,
 * and would anything stop rendering", and a list answers that without a viewport
 * model, a zoom level, or a layout engine to be wrong about.
 *
 * Register is the same dense operator console as the rest of the panel: window
 * ids, coordinates and areas are monospace because they are read as values and
 * compared column-wise, labels are short, and colour carries meaning rather than
 * decoration -- amber for a window that would leave its Desktop, red only for a
 * plan that would starve a window.
 */
export function DesktopParkModal({
  open,
  park,
  onClose,
}: {
  open: boolean;
  park: DesktopParkHandle;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (open && !node.open) node.showModal?.();
    else if (!open && node.open) node.close?.();
  }, [open]);

  return (
    <dialog
      ref={dialog}
      aria-label="Desktop park"
      onClose={onClose}
      onCancel={onClose}
      onClick={(event) => {
        // The backdrop is the dialog element itself; a click landing on it rather
        // than on the panel inside is a click outside.
        if (event.target === dialog.current) onClose();
      }}
      className="m-auto max-h-[88dvh] w-[min(52rem,94vw)] overflow-hidden rounded-xl border border-border
        bg-card p-0 text-foreground shadow-2xl backdrop:bg-black/40"
    >
      {open ? <DesktopParkPanel park={park} onClose={onClose} /> : null}
    </dialog>
  );
}

/**
 * The panel's content, exported separately from the dialog that carries it.
 *
 * jsdom does not implement `showModal`, so a `<dialog>` rendered in a test has no
 * accessible content at all and every role query inside it comes back empty.
 * Splitting the shell from the body lets the body be tested for what it actually
 * does rather than through a wrapper the test environment cannot open.
 */
export function DesktopParkPanel({
  park,
  onClose,
}: {
  park: DesktopParkHandle;
  onClose: () => void;
}) {
  const { view, action, busy } = park;
  const ready = view.kind === "ready" ? view : null;
  const movesById = useMemo(() => {
    const map = new Map<number, ParkMove>();
    for (const move of ready?.plan.moves ?? []) map.set(move.id, move);
    return map;
  }, [ready]);
  const groups = useMemo(() => groupByDesktop(ready?.state), [ready]);
  const unsound = ready ? !ready.plan.sound : false;
  // One source at a time for now: a window id, or "display" for the whole
  // active screen. The grid comes after a compositor; this proves the delivery
  // path with the piece that already exists.
  const [watching, setWatching] = useState<number | "display" | null>(null);
  // A/B seam for the delivery spike: WebRTC (transport owns timing) against
  // MSE over HTTP (the page owns timing). Default is the contender under test.
  const [transport, setTransport] = useState<"rtc" | "mse">("rtc");
  // Pseudo-fullscreen: a layout state, not the Fullscreen API. The app owns
  // the webview, so filling the viewport is CSS, the gesture overlay
  // survives, and iOS's native video player (which would eat the overlay)
  // never enters the picture.
  const [expanded, setExpanded] = useState(false);
  const [tile, setTile] = useState<DesktopStreamState>({ kind: "connecting" });
  const [pointerMode, setPointerMode] = useState(false);
  const [pointerTransport, setPointerTransport] = useState<PointerInputTransport | null>(null);
  const watchedWindow =
    typeof watching === "number" ? ready?.state.windows.find((w) => w.id === watching) ?? null : null;
  const displayFrame = ready?.plan.display.frame ?? null;
  const watched =
    watching === "display" && displayFrame
      ? {
          id: "display" as const,
          app: "Desktop",
          title: `the active Space, ${displayFrame.w}\u00d7${displayFrame.h}`,
          frame: displayFrame,
        }
      : watchedWindow;

  useEffect(() => {
    setPointerMode(false);
    setPointerTransport(null);
  }, [watching, transport]);

  useEffect(() => {
    if (!pointerTransport) setPointerMode(false);
  }, [pointerTransport]);

  const pointerAvailable =
    transport === "rtc" && pointerTransport !== null && tile.kind === "playing";

  return (
    <div className="flex max-h-[88dvh] flex-col">
      <header className="flex min-h-11 shrink-0 items-center gap-2 border-b border-border px-3">
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">Desktop park</h2>
        {ready ? (
          <p className="hidden shrink-0 font-mono text-xs text-muted-foreground sm:block">
            {ready.state.counts.parkable} windows · {ready.state.counts.elsewhere} elsewhere ·
            {" "}Desktop {ready.state.activeSpace.index}
          </p>
        ) : null}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground
            transition-colors hover:bg-muted hover:text-foreground active:bg-muted/70
            focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary"
        >
          <X className="size-4" aria-hidden />
        </button>
      </header>

      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <Action
          onClick={park.park}
          busy={busy && action.kind === "running" && action.what === "park"}
          disabled={busy || !ready || unsound}
          tone="primary"
          label={ready ? `Park ${ready.state.counts.parkable} windows` : "Park"}
        />
        <Action
          onClick={park.restore}
          busy={busy && action.kind === "running" && action.what === "restore"}
          disabled={busy}
          tone="ghost"
          icon={<RotateCcw className="size-3.5" aria-hidden />}
          label="Restore"
        />
        <button
          type="button"
          onClick={() => setWatching((current) => (current === "display" ? null : "display"))}
          disabled={!ready}
          className={`rounded-md px-2 py-1 text-xs transition-colors
            hover:bg-muted hover:text-foreground active:bg-muted/70 focus-visible:outline-2
            focus-visible:-outline-offset-2 focus-visible:outline-primary
            disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent
            ${watching === "display" ? "bg-accent/60 text-foreground" : "text-muted-foreground"}`}
        >
          {watching === "display" ? "Stop desktop" : "Watch desktop"}
        </button>
        <button
          type="button"
          onClick={park.load}
          disabled={busy}
          className="ml-auto rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors
            hover:bg-muted hover:text-foreground active:bg-muted/70 focus-visible:outline-2
            focus-visible:-outline-offset-2 focus-visible:outline-primary
            disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
        >
          Refresh
        </button>
      </div>

      {unsound ? (
        <p className="shrink-0 border-b border-destructive/40 bg-destructive/10 px-3 py-2 text-xs
          text-destructive">
          This plan would leave {ready?.plan.starved.length} window(s) fully covered, and a fully
          covered window stops rendering. Parking is disabled until the plan is sound.
        </p>
      ) : null}

      <Outcome action={action} />

      {watched ? (
        <section
          className={
            expanded
              ? "fixed inset-0 z-50 flex flex-col bg-background"
              : "shrink-0 border-b border-border"
          }
        >
          <div className="flex items-center gap-2 px-3 py-1.5 text-xs">
            <span className="min-w-0 flex-1 truncate">
              <span className="text-muted-foreground">{watched.app}</span>{" "}
              {watched.title || "untitled"}
            </span>
            <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
              {tile.kind === "playing"
                ? `${tile.codec} · first frame ${tile.firstFrameMs}ms`
                : tile.kind}
            </span>
            <button
              type="button"
              aria-pressed={pointerMode}
              disabled={!pointerAvailable}
              onClick={() => {
                setPointerMode((current) => !current);
                setExpanded(true);
              }}
              title={
                pointerAvailable
                  ? "Relative pointer: drag to move, tap to click, two fingers to scroll"
                  : "Pointer control becomes available when the WebRTC tile is playing"
              }
              className={`inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 font-mono
                text-[10px] transition-colors focus-visible:outline-2
                focus-visible:-outline-offset-2 focus-visible:outline-primary
                disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent
                ${pointerMode
                  ? "bg-primary text-primary-foreground hover:bg-primary/90 active:bg-primary/80"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground active:bg-muted/70"}`}
            >
              <MousePointer2 className="size-3" aria-hidden />
              pointer
            </button>
            <button
              type="button"
              onClick={() => setExpanded((current) => !current)}
              title={expanded ? "Exit full screen" : "Full screen"}
              className="shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground
                transition-colors hover:bg-muted hover:text-foreground active:bg-muted/70
                focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary"
            >
              {expanded ? "\u2921 exit" : "\u2922 full"}
            </button>
            <button
              type="button"
              onClick={() => {
                setPointerMode(false);
                setTransport((current) => (current === "rtc" ? "mse" : "rtc"));
              }}
              title="Switch tile transport"
              className="shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground
                transition-colors hover:bg-muted hover:text-foreground active:bg-muted/70
                focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary"
            >
              {transport}
            </button>
            <button
              type="button"
              onClick={() => {
                setWatching(null);
                setExpanded(false);
                setPointerMode(false);
              }}
              className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground
                transition-colors hover:bg-muted hover:text-foreground active:bg-muted/70
                focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary"
            >
              stop
            </button>
          </div>
          <div
            className={
              expanded
                ? "min-h-0 flex-1"
                : "mx-3 mb-2 max-h-64 overflow-hidden rounded border border-border"
            }
          >
            <TileViewport
              className={expanded ? "h-full" : ""}
              pointerMode={pointerMode}
              sendPointerInput={pointerTransport?.send}
            >
            {transport === "rtc" ? (
              <TileStreamRtc
                key={`rtc-${watched.id}`}
                windowID={watched.id}
                width={watched.frame.w}
                height={watched.frame.h}
                fill={expanded}
                onState={setTile}
                onPointerTransport={setPointerTransport}
              />
            ) : (
              <TileStream
                key={`mse-${watched.id}`}
                windowID={watched.id}
                width={watched.frame.w}
                height={watched.frame.h}
                fill={expanded}
                onState={setTile}
              />
            )}
            </TileViewport>
          </div>
        </section>
      ) : null}

      {/* The scroller. Everything above and below it is fixed height so the list is
          the only thing that moves. */}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {view.kind === "loading" || view.kind === "idle" ? (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground">Reading Desktops…</p>
        ) : null}
        {view.kind === "error" ? (
          <p className="px-3 py-6 text-center text-sm text-destructive">{view.message}</p>
        ) : null}
        {ready && groups.length === 0 ? (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground">
            No parkable windows.
          </p>
        ) : null}
        {groups.map((group) => (
          <section key={group.space}>
            <h3
              // Fully opaque rather than translucent: rows scroll underneath it, and
              // at 95% the text of the row passing behind was legible through the band.
              className="sticky top-0 z-10 flex items-center gap-2 border-b border-border
                bg-card px-3 py-1.5 text-xs font-medium"
            >
              <span>Desktop {group.space}</span>
              {group.active ? (
                <span className="rounded bg-primary/15 px-1.5 py-0.5 font-mono text-[10px]
                  uppercase tracking-wide text-primary">
                  active
                </span>
              ) : null}
              <span className="ml-auto font-mono text-muted-foreground">
                {group.windows.length}
              </span>
            </h3>
            <ul>
              {group.windows.map((w) => (
                <WindowRow
                  key={w.id}
                  window={w}
                  move={movesById.get(w.id)}
                  watching={w.id === watching}
                  onWatch={() => setWatching((current) => (current === w.id ? null : w.id))}
                />
              ))}
            </ul>
          </section>
        ))}
      </div>

      {ready ? (
        <footer className="shrink-0 border-t border-border px-3 py-2 font-mono text-[11px]
          text-muted-foreground">
          strip {ready.plan.options.strip}pt · step {ready.plan.options.step}pt · display{" "}
          {ready.plan.display.frame.w}×{ready.plan.display.frame.h}
          {ready.plan.overflow.length > 0
            ? ` · ${ready.plan.overflow.length} will not fit and stay put`
            : ""}
        </footer>
      ) : null}
    </div>
  );
}

function WindowRow({
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
    <li className={`flex items-baseline gap-2 border-b border-border/50 px-3 py-1.5 text-sm
      last:border-b-0 ${watching ? "bg-accent/40" : ""}`}>
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
      <span className="w-8 shrink-0 text-right font-mono text-[11px] text-muted-foreground">
        #{w.id % 100000}
      </span>
    </li>
  );
}

function Outcome({ action }: { action: DesktopParkHandle["action"] }) {
  if (action.kind === "none" || action.kind === "running") return null;
  if (action.kind === "failed") {
    return (
      <p className="shrink-0 border-b border-destructive/40 bg-destructive/10 px-3 py-2 text-xs
        text-destructive">
        {action.what === "park" ? "Park" : "Restore"} failed: {action.message}
      </p>
    );
  }
  if (action.kind === "parked") {
    const { report } = action;
    const failed = [...report.gathered, ...report.laid].filter((step) => !step.ok);
    const reordered =
      report.orderBeforeGather.join(",") !== report.observedOrder.join(",");
    return (
      <p className="shrink-0 border-b border-border bg-muted/40 px-3 py-2 font-mono text-[11px]
        text-muted-foreground">
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
    <p className="shrink-0 border-b border-border bg-muted/40 px-3 py-2 font-mono text-[11px]
      text-muted-foreground">
      {report.found
        ? Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(" · ") || "nothing to restore"
        : "no park manifest on disk"}
      {report.manifestCleared ? " · manifest cleared" : ""}
    </p>
  );
}

function Action({
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
    "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors "
    + "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary "
    + "disabled:cursor-not-allowed disabled:opacity-50";
  const skin = tone === "primary"
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

interface DesktopGroup {
  space: number;
  active: boolean;
  windows: ParkWindow[];
}

/** Windows grouped by the Desktop they are on now, active Desktop first. */
export function groupByDesktop(state: ParkStateResponse | undefined): DesktopGroup[] {
  if (!state) return [];
  const bySpace = new Map<number, ParkWindow[]>();
  for (const w of state.windows) {
    const list = bySpace.get(w.space);
    if (list) list.push(w);
    else bySpace.set(w.space, [w]);
  }
  return [...bySpace.entries()]
    .map(([space, windows]) => ({
      space,
      active: space === state.activeSpace.index,
      windows,
    }))
    .sort((a, b) => Number(b.active) - Number(a.active) || a.space - b.space);
}
