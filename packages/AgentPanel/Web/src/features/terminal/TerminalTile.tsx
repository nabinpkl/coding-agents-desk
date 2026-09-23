import { useCallback, useEffect, useRef, useState } from "react";
import { Paperclip } from "lucide-react";
import type { AgentTerminalContext } from "@agentdesk/agent-feed-wire";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import { drawsOwnKeyboard } from "@/features/keyboard/softwareKeyboard";
import { TerminalKeyRail } from "@/features/terminal/TerminalKeyRail";
import { useAgentTerminal, type AgentTerminalState } from "@/features/terminal/useAgentTerminal";
import {
  clampTileGrid,
  loadTileGrid,
  storeTileGrid,
  type TileGrid,
} from "@/features/terminal/terminalTileSize";

/**
 * One terminal in the wall, at a grid its reader chose.
 *
 * Sixty columns until dragged, because that is what the programs inside a tmux session are
 * written for -- and because a tile that measured itself on every layout would push its own
 * size onto the PTY, and through it onto whatever terminal the user has the same tmux session
 * open in. A drag asks the pane for a new shape through the ordinary viewport claim instead,
 * which the sidecar refuses while a human is attached; the tile then stays where it was.
 *
 * Three handles share one drag: the corner grows both axes, the right edge grows columns
 * alone, and the bottom edge grows rows alone. Every handle persists through the same grid
 * store, so a width-only or height-only drag is remembered per session like a diagonal one.
 */
const GRID_STEP = 1;
const GRID_FAST_STEP = 10;

/**
 * How long a drag rests before the staged grid is asked for mid-drag. Short enough to feel
 * live, long enough that one continuous motion is a few reflows rather than one per pixel:
 * every ask resizes the pane and reflows the program inside it.
 */
const DRAG_LIVE_MS = 150;

/** Which axes a resize handle moves: the corner moves both, the edges move one. */
type DragAxis = "both" | "columns" | "rows";

export interface TerminalTileSession {
  name: string;
  /** Omitted by a caller that has not listed tmux; the header then says nothing about watchers. */
  attachedClients?: number;
}

export function TerminalTile({ feed, session, target, storageKey, onAttachImage }: {
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
  // Constant for this mount: the sizing is the effect's reopen key, so a drag must never change
  // it -- the new grid travels through `resizeGrid` on the live attachment instead.
  const [initialGrid] = useState<TileGrid>(() => loadTileGrid(storageKey));
  const { mountRef, labels, focused, modifiers, toggleModifier, pressKey, resizeGrid, measureCell } =
    useAgentTerminal({
      feed,
      context,
      sizing: { kind: "fixed", columns: initialGrid.columns, rows: initialGrid.rows },
      onState,
    });
  // Read once per tile rather than at import: a browser does not grow a software keyboard part way
  // through a session, but a test has to be able to say which kind of browser it is.
  const [softwareKeyboard] = useState(drawsOwnKeyboard);
  // Only where the keyboard is missing these keys, and only while that keyboard is up: a desktop
  // browser has Esc and Ctrl already, and a rail standing under every tile would spend height on
  // terminals nobody is typing into.
  const showsKeyRail = focused && softwareKeyboard;

  // The grid the pane was last asked for. Drags accumulate from here rather than from the
  // opening grid, so a second drag starts where the first left off.
  const committed = useRef<TileGrid>(initialGrid);
  const applyGrid = useCallback((grid: TileGrid, persist: boolean): TileGrid => {
    const bounded = clampTileGrid(grid);
    committed.current = bounded;
    resizeGrid(bounded.columns, bounded.rows);
    if (persist) storeTileGrid(storageKey, bounded);
    return bounded;
  }, [resizeGrid, storageKey]);

  // What the pane has not been asked for yet. A drag stages it behind the badge and the
  // ask goes out on settle (a short debounce) and on release: every ask resizes the pane,
  // which reflows the program inside it, and a fullscreen TUI repaints itself on each one --
  // measured as the flicker this drag used to ship with when every pixel asked. The badge is
  // the per-pixel feedback while the tile itself follows on settle.
  const pendingAsk = useRef<TileGrid | null>(null);
  const flushAsk = useCallback((): void => {
    const asked = pendingAsk.current;
    pendingAsk.current = null;
    if (asked) resizeGrid(asked.columns, asked.rows);
  }, [resizeGrid]);

  // The settle timer behind live resize. Each move restarts it; firing means the pointer
  // rested, so the staged grid is asked for while the drag is still in flight.
  const liveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearLiveTimer = useCallback((): void => {
    if (liveTimer.current !== null) {
      clearTimeout(liveTimer.current);
      liveTimer.current = null;
    }
  }, []);
  const scheduleLive = useCallback((): void => {
    clearLiveTimer();
    liveTimer.current = setTimeout(() => {
      liveTimer.current = null;
      flushAsk();
    }, DRAG_LIVE_MS);
  }, [clearLiveTimer, flushAsk]);
  useEffect(() => clearLiveTimer, [clearLiveTimer]);

  // A drag in flight, or null. The tile's own box does not grow until the pane takes the shape
  // and the checkpoint repaints it, so the badge beside the handle is the live feedback. The
  // axis is which handle started it: the corner moves both, the edges move one.
  const drag = useRef<{ startX: number; startY: number; start: TileGrid; axis: DragAxis } | null>(null);
  const [dragGrid, setDragGrid] = useState<TileGrid | null>(null);
  // The footer picker's other half: the button clicks it, and the change hands the files to
  // the card's accept.
  const picker = useRef<HTMLInputElement | null>(null);

  const gridFromPointer = useCallback((clientX: number, clientY: number): TileGrid | null => {
    const active = drag.current;
    const cell = measureCell();
    if (!active || !cell) return null;
    return clampTileGrid({
      columns: active.axis === "rows"
        ? active.start.columns
        : active.start.columns + Math.round((clientX - active.startX) / cell.width),
      rows: active.axis === "columns"
        ? active.start.rows
        : active.start.rows + Math.round((clientY - active.startY) / cell.height),
    });
  }, [measureCell]);

  const beginDrag = useCallback((clientX: number, clientY: number, axis: DragAxis): void => {
    clearLiveTimer();
    drag.current = { startX: clientX, startY: clientY, start: committed.current, axis };
    setDragGrid(null);
  }, [clearLiveTimer]);

  const moveDrag = useCallback((clientX: number, clientY: number): void => {
    if (!drag.current) return;
    const grid = gridFromPointer(clientX, clientY);
    if (!grid) return;
    committed.current = grid;
    pendingAsk.current = grid;
    scheduleLive();
    setDragGrid((previous) =>
      previous && previous.columns === grid.columns && previous.rows === grid.rows
        ? previous
        : grid);
  }, [gridFromPointer, scheduleLive]);

  const endDrag = useCallback((): void => {
    if (!drag.current) return;
    drag.current = null;
    setDragGrid(null);
    clearLiveTimer();
    flushAsk();
    storeTileGrid(storageKey, committed.current);
  }, [clearLiveTimer, flushAsk, storageKey]);

  const nudgeGrid = useCallback((columns: number, rows: number): void => {
    applyGrid(
      { columns: committed.current.columns + columns, rows: committed.current.rows + rows },
      true,
    );
  }, [applyGrid]);

  return (
    <section
      aria-label={`${label} terminal`}
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
      <div ref={mountRef} className="p-1" />
      {showsKeyRail ? (
        <TerminalKeyRail modifiers={modifiers} onModifier={toggleModifier} onKey={pressKey} />
      ) : null}
      <footer className="flex min-h-5 shrink-0 items-center gap-2 overflow-hidden border-t border-border px-2 font-mono text-[10px] text-muted-foreground">
        <span className="min-w-0 flex-1 truncate">
          {state?.kind === "error"
            ? state.message
            : state?.kind === "ended"
              ? "attach ended"
              // Before the first checkpoint the sync label still says "Opening terminal", which is
              // no longer true once the attach has answered: a fresh tmux client has no history to
              // replay, so it paints as ordinary output and no checkpoint ever arrives.
              : state?.kind === "ready" && labels.sync === "Opening terminal"
                ? "attached"
                : labels.sync}
        </span>
        {/* The pane's own shape, live through a drag: the badge tracks the pointer per pixel
            while this tracks what was asked, falling back to the opening grid before the
            attach answers. The source label is the far end's truth rather than the ask, so a
            resize refused while a human watches keeps showing the shape in force. */}
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
          {dragGrid
            ? `${dragGrid.columns}×${dragGrid.rows}`
            : labels.source
              ? labels.source.replace("Source ", "")
              : `${initialGrid.columns}×${initialGrid.rows}`}
        </span>
      </footer>
      {dragGrid ? (
        <span
          aria-live="polite"
          className="pointer-events-none absolute right-7 bottom-7 rounded bg-black/70 px-1.5 py-0.5 font-mono text-[10px] text-white"
        >
          {dragGrid.columns}×{dragGrid.rows}
        </span>
      ) : null}
      <button
        type="button"
        aria-label={`Resize ${label} terminal width`}
        title="Drag to resize width"
        onPointerDown={(event) => {
          if (event.pointerType === "mouse" && event.button !== 0) return;
          beginDrag(event.clientX, event.clientY, "columns");
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
          if (event.key === "ArrowLeft") nudgeGrid(-fast, 0);
          else if (event.key === "ArrowRight") nudgeGrid(fast, 0);
          else return;
          event.preventDefault();
        }}
        className="absolute top-1/2 right-0 flex h-12 w-4 -translate-y-1/2 cursor-ew-resize touch-none items-center justify-center bg-transparent text-muted-foreground/60 outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:bg-muted focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset"
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
          beginDrag(event.clientX, event.clientY, "rows");
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
          if (event.key === "ArrowUp") nudgeGrid(0, -fast);
          else if (event.key === "ArrowDown") nudgeGrid(0, fast);
          else return;
          event.preventDefault();
        }}
        className="absolute bottom-0 left-1/2 flex h-4 w-12 -translate-x-1/2 cursor-ns-resize touch-none items-center justify-center bg-transparent text-muted-foreground/60 outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:bg-muted focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset"
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
          if (event.key === "ArrowLeft") nudgeGrid(-fast, 0);
          else if (event.key === "ArrowRight") nudgeGrid(fast, 0);
          else if (event.key === "ArrowUp") nudgeGrid(0, -fast);
          else if (event.key === "ArrowDown") nudgeGrid(0, fast);
          else return;
          event.preventDefault();
        }}
        className="absolute right-0 bottom-0 size-6 cursor-nwse-resize touch-none rounded-tl bg-transparent text-muted-foreground/60 outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:bg-muted focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset"
      >
        <svg aria-hidden viewBox="0 0 16 16" className="size-4 translate-x-1 translate-y-1">
          <path d="M11 15 L15 11 L15 15 Z M7 15 L15 7 L15 9 L9 15 Z" fill="currentColor" />
        </svg>
      </button>
    </section>
  );
}
