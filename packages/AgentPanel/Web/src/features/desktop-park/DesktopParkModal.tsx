"use client";

import { useMemo, useRef, useState } from "react";
import { MousePointer2, RotateCcw, X } from "lucide-react";
import type { ParkMove } from "@agentdesk/agent-feed-wire";
import type { DesktopStreamState } from "@/features/desktop-viewer/DesktopStreamState";
import { TileStreamRtc, type DesktopControlTransport } from "@/features/desktop-viewer/tile-stream/TileStreamRtc";
import { TileViewport } from "@/features/desktop-viewer/tile-viewport/TileViewport";
import type { DesktopParkHandle } from "@/features/desktop-park/useDesktopPark";
import { Action, Outcome, WindowRow } from "@/features/desktop-park/DesktopParkRows";
import { groupByDesktop } from "@/features/desktop-park/desktopParkGroups";
import { useModal } from "@/hooks/dom/overlays";
import { useStateFor } from "@/hooks/state/useStateFor";

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

  useModal(dialog, open);

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
  // Pseudo-fullscreen: a layout state, not the Fullscreen API. The app owns
  // the webview, so filling the viewport is CSS, the gesture overlay
  // survives, and iOS's native video player (which would eat the overlay)
  // never enters the picture.
  const [expanded, setExpanded] = useState(false);
  const [tile, setTile] = useState<DesktopStreamState>({ kind: "connecting" });
  // Both belong to what is being watched, and start over when that changes.
  const [pointerMode, setPointerMode] = useStateFor(watching, () => false);
  const [pointerTransport, setPointerTransport] = useStateFor<DesktopControlTransport | null>(watching, () => null);
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

  // Pointer mode needs a transport to drive, and leaves with it.
  if (!pointerTransport && pointerMode) setPointerMode(false);

  const pointerAvailable = pointerTransport !== null && tile.kind === "playing";

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
              sendPointerInput={pointerTransport
                ? (input) => pointerTransport.send(input) === "sent"
                : undefined}
            >
            <TileStreamRtc
              key={watched.id}
              windowID={watched.id}
              width={watched.frame.w}
              height={watched.frame.h}
              fill={expanded}
              onState={setTile}
              onControlTransport={setPointerTransport}
            />
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
