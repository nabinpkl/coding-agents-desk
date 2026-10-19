import { useCallback, useRef, useState } from "react";
import { Paperclip } from "lucide-react";
import type { AgentTerminalContext } from "@agentdesk/agent-feed-wire";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import { TerminalKeyRail } from "@/features/terminal/TerminalKeyRail";
import { OnKeyboardBar } from "@/features/keyboard/KeyboardBar";
import { useAgentTerminal, type AgentTerminalState } from "@/features/terminal/useAgentTerminal";
import {
  clampTileBox,
  loadTileBox,
  loadTileGrid,
  storeTileBox,
  type TileBox,
  type TileGrid,
} from "@/features/terminal/terminalTileSize";

/**
 * One terminal in the wall, at a box its reader chose.
 *
 * A pure viewer: it follows the pane and never resizes it. tmux has one window size for
 * everyone, so asking the pane for the tile's shape reflowed the session in its owner's
 * terminal. The grid therefore stays the pane's shape -- always, which is also what keeps
 * long lines from wrapping into rows no scrollbar can undo -- and what the reader arranges
 * is the box: the fit scales the type to fill it, and past the type floor the mount scrolls
 * instead of clipping, so every column stays reachable.
 *
 * Three handles share one drag: the corner grows both axes, the right edge grows width
 * alone, and the bottom edge grows height alone. Every handle persists through the same box
 * store, so a width-only or height-only drag is remembered per session like a diagonal one.
 */
const GRID_STEP = 1;
const GRID_FAST_STEP = 10;

/** Which axes a resize handle moves: the corner moves both, the edges move one. */
type DragAxis = "both" | "width" | "height";

export interface TerminalTileSession {
  name: string;
  /** Omitted by a caller that has not listed tmux; the header then says nothing about watchers. */
  attachedClients?: number;
}

export function TerminalTile({
  feed,
  session,
  target,
  storageKey,
  onAttachImage,
}: {
  feed: SidecarDataSource;
  session: TerminalTileSession;
  /**
   * The tmux target to attach to: the session, or one of its `window` / `window.pane` targets.
   * Absent means the session, which lands on its active window's active pane.
   */
  target?: string;
  /** The child key (`machine:name`, or with a window/pane suffix) this grid is remembered under. */
  storageKey: string;
  /** Sends picked files down the card's image accept: bytes to the sidecar, path into the pane. */
  onAttachImage: (files: readonly File[]) => void;
}) {
  const [state, setState] = useState<AgentTerminalState | null>(null);
  const context: AgentTerminalContext = { kind: "tmux", session: target ?? session.name };
  const label = target ?? session.name;
  const onState = useCallback((_context: AgentTerminalContext, next: AgentTerminalState) => {
    setState(next);
  }, []);
  // Constant for this mount: the sizing is the effect's reopen key, and the box below is
  // local presentation -- the grid stays the pane's shape either way.
  const [initialGrid] = useState<TileGrid>(() => loadTileGrid(storageKey));
  const { mountRef, labels, focused, modifiers, toggleModifier, pressKey, measureCell } = useAgentTerminal({
    feed,
    context,
    sizing: { kind: "fixed", columns: initialGrid.columns, rows: initialGrid.rows },
    // Follow, never claim: this tile is a look at somebody else's session, and claiming
    // would set the tmux window's one shared size to whatever box this tile holds.
    paneShape: "follow",
    onState,
  });

  // The box on screen, or null while unarranged: the mount shrink-wraps the screen until
  // the reader gives it a size. Drags accumulate from here, so a second drag starts where
  // the first left off; the pane's shape never enters it, which is what keeps the grid --
  // and every long line in it -- whole.
  const [box, setBox] = useState<TileBox | null>(() => loadTileBox(storageKey));
  const applyBox = useCallback(
    (next: TileBox, persist: boolean): TileBox => {
      const bounded = clampTileBox(next);
      setBox((previous) =>
        previous && previous.width === bounded.width && previous.height === bounded.height ? previous : bounded,
      );
      if (persist) storeTileBox(storageKey, bounded);
      return bounded;
    },
    [storageKey],
  );

  // A drag in flight, or null. The box follows the pointer per pixel through the badge;
  // the pane is never asked, so a drag reflows only this view. The axis is which handle
  // started it: the corner moves both, the edges move one.
  const drag = useRef<{ startX: number; startY: number; start: TileBox; axis: DragAxis } | null>(null);
  const [dragBox, setDragBox] = useState<TileBox | null>(null);
  // The staged box, for release to persist: state above is the render, this is the record.
  const stagedBox = useRef<TileBox | null>(null);
  // The footer picker's other half: the button clicks it, and the change hands the files to
  // the card's accept.
  const picker = useRef<HTMLInputElement | null>(null);

  // The box the pointer is staging, in CSS pixels: the tile draws it live while the badge
  // names it, and release persists it. Starts from the box on screen -- the arranged one,
  // or the mount's own while unarranged -- so a drag never jumps.
  const boxFromPointer = useCallback((clientX: number, clientY: number): TileBox | null => {
    const active = drag.current;
    if (!active) return null;
    return clampTileBox({
      width: active.axis === "height" ? active.start.width : active.start.width + (clientX - active.startX),
      height: active.axis === "width" ? active.start.height : active.start.height + (clientY - active.startY),
    });
  }, []);

  const measureBox = useCallback((): TileBox | null => {
    const mount = mountRef.current;
    if (!mount) return null;
    const rect = mount.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 ? { width: rect.width, height: rect.height } : null;
  }, [mountRef]);

  const beginDrag = useCallback(
    (clientX: number, clientY: number, axis: DragAxis): void => {
      // From the arranged box first: the pane never moves it, so state cannot go stale the
      // way a grid store could. The live mount is only the start while never arranged.
      const live = box ?? measureBox();
      const start = live ?? { width: 0, height: 0 };
      drag.current = { startX: clientX, startY: clientY, start, axis };
      stagedBox.current = null;
      setDragBox(null);
    },
    [box, measureBox],
  );

  const moveDrag = useCallback(
    (clientX: number, clientY: number): void => {
      if (!drag.current) return;
      const staged = boxFromPointer(clientX, clientY);
      if (!staged) return;
      stagedBox.current = staged;
      setBox(staged);
      setDragBox((previous) =>
        previous && previous.width === staged.width && previous.height === staged.height ? previous : staged,
      );
    },
    [boxFromPointer],
  );

  const endDrag = useCallback((): void => {
    if (!drag.current) return;
    drag.current = null;
    setDragBox(null);
    if (stagedBox.current) storeTileBox(storageKey, stagedBox.current);
    stagedBox.current = null;
  }, [storageKey]);

  // A press moves the box by cells at the type on screen: one cell, or ten with shift.
  // Without a measured cell there is no step to take, so the press is ignored.
  const nudgeBox = useCallback(
    (deltaWidth: number, deltaHeight: number): void => {
      const from = box ?? measureBox();
      if (!from) return;
      applyBox({ width: from.width + deltaWidth, height: from.height + deltaHeight }, true);
    },
    [applyBox, box, measureBox],
  );

  // One cell step at the type on screen, for the keyboard handlers below.
  const nudgeCells = useCallback(
    (columns: number, rows: number): void => {
      const cell = measureCell();
      if (!cell) return;
      nudgeBox(columns * cell.width, rows * cell.height);
    },
    [measureCell, nudgeBox],
  );

  return (
    <section
      aria-label={`${label} terminal`}
      // Its keys go to the PTY rather than to xterm's field, so it puts its own rail on the keyboard
      // bar (`features/keyboard`) in place of the bar's Esc, Tab and arrows.
      data-keyboard-bar="keys"
      className="relative flex w-fit flex-col overflow-hidden rounded border border-border bg-white dark:bg-[#0b0e14]"
    >
      <header className="flex min-h-6 shrink-0 items-center justify-between gap-2 border-b border-border px-2 font-mono text-[10px]">
        <span className="truncate font-semibold">{label}</span>
        <span className="shrink-0 text-muted-foreground">
          {session.attachedClients === undefined
            ? ""
            : session.attachedClients > 0
              ? `${session.attachedClients} watching`
              : "unattached"}
        </span>
      </header>
      {/* Scrolls instead of clipping: a tile dragged past its card keeps every column
          reachable, the way a band does. The fit floors the type at its minimum first and
          only then overflows, so this scrolls a large grid rather than shrinking it away. */}
      <div
        ref={mountRef}
        style={box ? { width: box.width, height: box.height } : undefined}
        className="min-h-0 min-w-0 overflow-auto p-1 [&>.xterm]:shrink-0"
      />
      <OnKeyboardBar focused={focused}>
        <TerminalKeyRail modifiers={modifiers} onModifier={toggleModifier} onKey={pressKey} />
      </OnKeyboardBar>
      <footer className="flex min-h-5 shrink-0 items-center gap-2 overflow-hidden border-t border-border px-2 font-mono text-[10px] text-muted-foreground">
        <span className="min-w-0 flex-1 truncate">
          {state?.kind === "error"
            ? state.message
            : state?.kind === "ended"
              ? "attach ended"
              : // Before the first checkpoint the sync label still says "Opening terminal", which is
                // no longer true once the attach has answered: a fresh tmux client has no history to
                // replay, so it paints as ordinary output and no checkpoint ever arrives.
                state?.kind === "ready" && labels.sync === "Opening terminal"
                ? "attached"
                : labels.sync}
        </span>
        {/* The pane's own shape, live: the tile follows it and never asks for its own, so
            the source label is the far end's truth and the drag badge beside the handle is
            the staged box. Falls back to the opening grid before the attach answers. */}
        <button
          type="button"
          aria-label={`Attach an image to ${label}`}
          title="Attach image"
          onClick={() => picker.current?.click()}
          className="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground/60 outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:bg-muted focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset"
        >
          <Paperclip className="size-3.5" aria-hidden />
        </button>
        {/* The picker's other half lives in the card's menu for closed rows; this one serves
            the open tile's footer. Same accept, same MIME guide, cleared the same way so
            picking one file twice fires twice. Unlabelled: the button beside it names it. */}
        <input
          ref={picker}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          multiple
          aria-hidden="true"
          tabIndex={-1}
          className="hidden"
          onChange={(event) => {
            onAttachImage([...(event.currentTarget.files ?? [])]);
            event.currentTarget.value = "";
          }}
        />
        <span
          className="ml-auto shrink-0 tabular-nums"
          title="Terminal size (columns × rows)"
          aria-label="Terminal size"
        >
          {dragBox
            ? `${Math.round(dragBox.width)}×${Math.round(dragBox.height)}`
            : labels.source
              ? labels.source.replace("Source ", "")
              : `${initialGrid.columns}×${initialGrid.rows}`}
        </span>
      </footer>
      {dragBox ? (
        <span
          aria-live="polite"
          className="pointer-events-none absolute right-7 bottom-7 rounded bg-black/70 px-1.5 py-0.5 font-mono text-[10px] text-white"
        >
          {Math.round(dragBox.width)}×{Math.round(dragBox.height)}
        </span>
      ) : null}
      <button
        type="button"
        aria-label={`Resize ${label} terminal width`}
        title="Drag to resize width"
        onPointerDown={(event) => {
          if (event.pointerType === "mouse" && event.button !== 0) return;
          beginDrag(event.clientX, event.clientY, "width");
          try {
            event.currentTarget.setPointerCapture(event.pointerId);
          } catch {
            // A test double without capture still drags: moves keep targeting the handle.
          }
        }}
        onPointerMove={(event) => moveDrag(event.clientX, event.clientY)}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={(event) => {
          const fast = event.shiftKey ? GRID_FAST_STEP : GRID_STEP;
          if (event.key === "ArrowLeft") nudgeCells(-fast, 0);
          else if (event.key === "ArrowRight") nudgeCells(fast, 0);
          else return;
          event.preventDefault();
        }}
        className="absolute top-1/2 right-0 flex h-12 w-4 -translate-y-1/2 cursor-ew-resize touch-none items-center justify-center bg-muted/40 text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground active:bg-muted/80 focus-visible:bg-muted focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset"
      >
        <svg aria-hidden viewBox="0 0 8 16" className="h-4 w-2">
          <path d="M2 2 L2 14 M6 2 L6 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
      <button
        type="button"
        aria-label={`Resize ${label} terminal height`}
        title="Drag to resize height"
        onPointerDown={(event) => {
          if (event.pointerType === "mouse" && event.button !== 0) return;
          beginDrag(event.clientX, event.clientY, "height");
          try {
            event.currentTarget.setPointerCapture(event.pointerId);
          } catch {
            // A test double without capture still drags: moves keep targeting the handle.
          }
        }}
        onPointerMove={(event) => moveDrag(event.clientX, event.clientY)}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={(event) => {
          const fast = event.shiftKey ? GRID_FAST_STEP : GRID_STEP;
          if (event.key === "ArrowUp") nudgeCells(0, -fast);
          else if (event.key === "ArrowDown") nudgeCells(0, fast);
          else return;
          event.preventDefault();
        }}
        className="absolute bottom-0 left-1/2 flex h-4 w-12 -translate-x-1/2 cursor-ns-resize touch-none items-center justify-center bg-muted/40 text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground active:bg-muted/80 focus-visible:bg-muted focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset"
      >
        <svg aria-hidden viewBox="0 0 16 8" className="h-2 w-4">
          <path d="M2 2 L14 2 M2 6 L14 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
      <button
        type="button"
        aria-label={`Resize ${label} terminal`}
        title="Drag to resize"
        onPointerDown={(event) => {
          if (event.pointerType === "mouse" && event.button !== 0) return;
          beginDrag(event.clientX, event.clientY, "both");
          try {
            event.currentTarget.setPointerCapture(event.pointerId);
          } catch {
            // A test double without capture still drags: moves keep targeting the handle.
          }
        }}
        onPointerMove={(event) => moveDrag(event.clientX, event.clientY)}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={(event) => {
          const fast = event.shiftKey ? GRID_FAST_STEP : GRID_STEP;
          if (event.key === "ArrowLeft") nudgeCells(-fast, 0);
          else if (event.key === "ArrowRight") nudgeCells(fast, 0);
          else if (event.key === "ArrowUp") nudgeCells(0, -fast);
          else if (event.key === "ArrowDown") nudgeCells(0, fast);
          else return;
          event.preventDefault();
        }}
        className="absolute right-0 bottom-0 size-6 cursor-nwse-resize touch-none rounded-tl bg-muted/40 text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground active:bg-muted/80 focus-visible:bg-muted focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset"
      >
        <svg aria-hidden viewBox="0 0 16 16" className="size-4 translate-x-1 translate-y-1">
          <path d="M11 15 L15 11 L15 15 Z M7 15 L15 7 L15 9 L9 15 Z" fill="currentColor" />
        </svg>
      </button>
    </section>
  );
}
