import { useRef, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import {
  MAX_CARD_HEIGHT,
  MAX_CARD_WIDTH,
  MIN_CARD_HEIGHT,
  MIN_CARD_WIDTH,
  clampCardHeight,
  clampCardWidth,
  type BotCardSize,
} from "@/features/bots/botCanvasPreferences";
import { effectiveScale } from "@/features/bots/useCanvasZoom";

/** How far one arrow key moves an edge. */
const KEY_STEP = 24;

export interface CardResize {
  /** What the card should actually be drawn at, which is not always what is stored. */
  width: number;
  height: number;
  /**
   * The card's right edge: the width grip, and under it the corner where the two edges meet. Null
   * when the width is not the reader's to set.
   */
  edge: ReactNode;
  /** The card's bottom edge. Null when the height is not the reader's to set. */
  bottom: ReactNode;
}

/**
 * A card you can drag by its edges, wherever one appears.
 *
 * Written once because a session inside a Bot is the same thing as a Bot on the canvas, one level
 * down: the same three grips, the same clamps, the same commit-on-release. The alternative was the
 * same hundred-odd lines twice, drifting apart the first time either was fixed.
 *
 * The grips are ROWS AND COLUMNS in the card rather than strips overlaid on its edges. The card
 * clips its own overflow, so a handle hanging outside the border would not be there to grab, and
 * one overlaid on the inside edge would land on the transcript's scrollbar.
 */
export function useCardResize({
  name,
  noun,
  size,
  displayWidth = null,
  canResizeWidth = true,
  canResizeHeight,
  onResize,
  onResizeCommit,
}: {
  /** What the grips call the thing they resize, e.g. the Bot's name or the session's title. */
  name: string;
  /** The word after the name in a grip's label, so a screen reader hears which level it is on. */
  noun: "card" | "session";
  size: BotCardSize;
  /**
   * A width to draw at instead of the stored one, and never to write back. Set when the canvas is
   * too narrow to hold two cards and shows one at a time, so a phone cannot overwrite the width
   * something was given on a Mac. The width grip goes with it: there is nowhere else to drag to.
   */
  displayWidth?: number | null;
  /**
   * Whether either edge is the reader's at all. A session is a row until it is opened, and a row is
   * as wide and as tall as what is in it -- there is nothing to drag and nothing a drag would mean.
   */
  canResizeWidth?: boolean;
  canResizeHeight: boolean;
  /** Live during a drag, so the card follows the pointer. Not written to storage. */
  onResize: (size: BotCardSize) => void;
  /** The size to keep, on pointer release or a key press. */
  onResizeCommit: (size: BotCardSize) => void;
}): CardResize {
  // `scale` is what the grip was DRAWN at when the drag began, which is 1 unless the canvas's zoom
  // mode is on. A pointer delta arrives in screen pixels and the width it is added to is a layout
  // one, so under a scaled canvas a drag of forty pixels would grow the card by forty divided by
  // nothing and the edge would run away from the finger. Read once, with the rest of the start
  // state, rather than per event.
  const drag = useRef<
    { pointerId: number; startX: number; startY: number; from: BotCardSize; scale: number } | null
  >(null);

  // The room each edge has to move in, which the window and the panel are no part of: a card bigger
  // than the screen is a card you asked to see more of at once, and the canvas scrolls. Asked with a
  // finite maximum rather than `Infinity`, which the clamps read as a number they cannot trust and
  // answer with the default.
  const widthWithin = (value: number): number => clampCardWidth(value);
  const heightWithin = (value: number): number => clampCardHeight(value);
  const widest = (): number => widthWithin(MAX_CARD_WIDTH);
  const tallest = (): number => heightWithin(MAX_CARD_HEIGHT);
  // What this card actually stands at: the remembered size held inside its own range. A size saved
  // on a bigger screen would otherwise be reported as the card's while CSS quietly drew it smaller,
  // and a drag would then start from a number the card was never at.
  const width = displayWidth ?? widthWithin(size.width);
  const height = heightWithin(size.height);
  const commit = (next: Partial<BotCardSize>): void =>
    onResizeCommit({
      // The card's OWN width while it is being shown at some other one, so releasing a height drag
      // on a phone does not quietly store the phone's width over it.
      width: displayWidth === null ? widthWithin(next.width ?? width) : size.width,
      height: heightWithin(next.height ?? height),
    });

  const resizeFromKeyboard = (
    event: KeyboardEvent<HTMLDivElement>,
    axis: "width" | "height",
  ): void => {
    const along =
      axis === "width"
        ? { less: "ArrowLeft", more: "ArrowRight", at: width, floor: MIN_CARD_WIDTH, ceiling: widest() }
        : { less: "ArrowUp", more: "ArrowDown", at: height, floor: MIN_CARD_HEIGHT, ceiling: tallest() };
    let next: number | null = null;
    if (event.key === along.more) next = along.at + KEY_STEP;
    else if (event.key === along.less) next = along.at - KEY_STEP;
    else if (event.key === "Home") next = along.floor;
    else if (event.key === "End") next = along.ceiling;
    if (next === null) return;
    event.preventDefault();
    commit({ [axis]: next });
  };

  const startDrag = (event: PointerEvent<HTMLDivElement>): void => {
    event.preventDefault();
    drag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      from: { width, height },
      scale: effectiveScale(event.currentTarget),
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const dragTo = (
    event: PointerEvent<HTMLDivElement>,
    axes: { width?: boolean; height?: boolean },
  ): void => {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    // Right and down grow the card, which is the direction the edge under the pointer is moving.
    const at = active.scale;
    onResize({
      width: axes.width ? widthWithin(active.from.width + (event.clientX - active.startX) / at) : width,
      height: axes.height ? heightWithin(active.from.height + (event.clientY - active.startY) / at) : height,
    });
  };

  const finishDrag = (event: PointerEvent<HTMLDivElement>): void => {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    // Kept before the release, because releasing a capture the browser never granted throws and
    // would otherwise take the whole drag's result with it.
    commit({});
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };

  const bottom = canResizeHeight ? (
    <div
      role="separator"
      aria-label={`Resize ${name} ${noun}`}
      aria-orientation="horizontal"
      aria-valuemin={MIN_CARD_HEIGHT}
      aria-valuemax={tallest()}
      aria-valuenow={height}
      aria-valuetext={`${height} pixels`}
      tabIndex={0}
      // Eight rather than the twelve these were. A grip is a row and a column IN the card rather
      // than a strip overlaid on its edge, so every pixel of it is a pixel the transcript beside it
      // does not get -- twelve on the right and twelve on the bottom, out of a card 446 wide. What
      // has to be grabbable is the whole strip, and the strip is the whole width of this element
      // whatever its size; the pill in the middle is two pixels and was never the target. Eight
      // still takes a pointer without hunting and gives the transcript back four each way.
      className="group flex h-2 shrink-0 cursor-row-resize touch-none items-center justify-center border-t border-border outline-none"
      onPointerDown={startDrag}
      onPointerMove={(event) => dragTo(event, { height: true })}
      onPointerUp={finishDrag}
      onPointerCancel={finishDrag}
      onKeyDown={(event) => resizeFromKeyboard(event, "height")}
    >
      <span className="h-0.5 w-8 rounded-full bg-border transition-colors group-hover:bg-primary/60 group-focus-visible:bg-primary" />
    </div>
  ) : null;

  const edge =
    canResizeWidth && displayWidth === null ? (
      <div className="flex w-2 shrink-0 flex-col">
        <div
          role="separator"
          aria-label={`Widen ${name} ${noun}`}
          aria-orientation="vertical"
          aria-valuemin={MIN_CARD_WIDTH}
          aria-valuemax={widest()}
          aria-valuenow={width}
          aria-valuetext={`${width} pixels`}
          tabIndex={0}
          className="group flex min-h-0 flex-1 cursor-col-resize touch-none items-center justify-center border-l border-border outline-none"
          onPointerDown={startDrag}
          onPointerMove={(event) => dragTo(event, { width: true })}
          onPointerUp={finishDrag}
          onPointerCancel={finishDrag}
          onKeyDown={(event) => resizeFromKeyboard(event, "width")}
        >
          <span className="h-8 w-0.5 rounded-full bg-border transition-colors group-hover:bg-primary/60 group-focus-visible:bg-primary" />
        </div>

        {/* Both axes in one drag, sitting where the two edges already meet.

            Hidden from assistive technology and left out of the tab order on purpose, which is not
            the usual answer for a control: it does nothing the two separators either side of it
            cannot already do, including from the keyboard, so exposing it would be a third name for
            the same card offering no third capability. It is a pointer shortcut over two controls
            that are properly labelled, and a pointer is the only thing that can express a diagonal.

            Only when there is a bottom edge for it to be the corner of. */}
        {canResizeHeight ? (
          <div
            aria-hidden
            // A tooltip because there is no label: the two separators say what they do through
            // their names, and this one has none to say it with.
            title="Resize both ways"
            // Square, and square at whatever the two edges are: this is the corner they meet in,
            // so its size is theirs rather than a number of its own.
            className="group flex size-2 shrink-0 cursor-nwse-resize touch-none items-center justify-center border-t border-l border-border"
            onPointerDown={startDrag}
            onPointerMove={(event) => dragTo(event, { width: true, height: true })}
            onPointerUp={finishDrag}
            onPointerCancel={finishDrag}
          >
            <span className="size-1 rounded-[1px] bg-border transition-colors group-hover:bg-primary/60" />
          </div>
        ) : null}
      </div>
    ) : null;

  return { width, height, edge, bottom };
}
