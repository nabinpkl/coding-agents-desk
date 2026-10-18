// A window that floats over the panel: hangs below the switch that opened it, carried by its
// header, resized by its right and bottom edges, and closed by its X.
//
// Written once for every such window -- the Father home over the Bot strip, an arena run's manager
// over its lanes -- because each is the same object with different contents: one session, shown
// as itself, in a drawer the reader can put where it is out of their way. The two used to be two
// windows that differed in everything a reader handles (one carried, one did not; one closed with
// an X, one folded down with a chevron).
//
// It hangs from below its switch like a drawer -- `fixed`, so nothing under it moves when it opens --
// pinned to the right and narrower than the viewport, so the page beside and below stays visible.
// Once carried, it stands where the hand left it, and that place and its size are remembered by
// `preferences`. However the viewport changes, a strip of it stays on screen to grab, and its
// bottom stays above a phone keyboard, so the composer at its foot is never under the keyboard it
// raised.

import { X } from "lucide-react";
import { useRef, useState, type HTMLAttributes, type PointerEvent, type ReactNode } from "react";
import { useCardResize } from "@/features/bots/cards/useCardResize";
import {
  clampFloatingPosition,
  clampFloatingTop,
  type FloatingWindowPosition,
  type FloatingWindowPreferences,
} from "@/features/floating-window/floatingWindowPreferences";
import { useDomSync } from "@/hooks/dom/useDomSync";
import { useEventListener } from "@/hooks/dom/useEventListener";

/** The gap between the switch and the window hanging from it, so the two read as one drawer. */
const SWITCH_GAP = 4;
/** How far a press travels before it is a carry rather than a click. */
const MOVE_THRESHOLD = 4;
/** What a press on the header may land on and still belong to that control, not the carry. */
const CONTROL = "button, a, input, select, textarea, [contenteditable='true']";

export function FloatingWindow({
  id,
  label,
  preferences,
  header,
  closeLabel,
  onClose,
  closeOnEscape = true,
  closeOnOutsidePress = true,
  sectionProps,
  children,
}: {
  /** The window's id, which its switch names in `aria-controls`: the switch is where it hangs. */
  id: string;
  /** The window's accessible name, and the name its resize grips say. */
  label: string;
  preferences: FloatingWindowPreferences;
  /** The header's contents, before its X: the header around them is what carries the window. */
  header: ReactNode;
  closeLabel: string;
  onClose: () => void;
  /**
   * Whether Escape closes it, the way it closes a dialog. Off for a window whose session runs in a
   * terminal pane, where Escape is the key that interrupts the harness.
   */
  closeOnEscape?: boolean;
  /**
   * Whether a press anywhere outside it puts it away, the way a menu goes. Off for a window the
   * reader keeps open beside what it is about, reading one and then the other.
   */
  closeOnOutsidePress?: boolean;
  /** Spread on the window itself, e.g. a file drop target's handlers. */
  sectionProps?: HTMLAttributes<HTMLElement>;
  children: ReactNode;
}) {
  const switchSelector = `[aria-controls="${id}"]`;
  // Owned here, so a drag writes storage only on release: the window follows the live values while
  // they move, and the stored ones are the answers they settled on.
  const [height, setHeight] = useState(preferences.loadHeight);
  const [width, setWidth] = useState(preferences.loadWidth);
  // Null until the reader first carries it: hanging below its switch is the default and needs
  // nothing stored. A stored place survives a smaller viewport by being pulled back on screen,
  // never by being forgotten, which would throw away an arrangement made on purpose.
  const [position, setPosition] = useState<FloatingWindowPosition | null>(preferences.loadPosition);
  const resize = useCardResize({
    name: label,
    noun: "card",
    size: { width, height },
    canResizeWidth: true,
    canResizeHeight: true,
    // Each dimension judged on its own, so a diagonal drag that crosses one bound still moves
    // freely on the other.
    onResize: (next) => {
      setWidth(preferences.clampWidth(next.width));
      setHeight(preferences.clampHeight(next.height));
    },
    onResizeCommit: (next) => {
      const committedWidth = preferences.clampWidth(next.width);
      const committedHeight = preferences.clampHeight(next.height);
      setWidth(committedWidth);
      setHeight(committedHeight);
      preferences.storeWidth(committedWidth);
      preferences.storeHeight(committedHeight);
    },
  });
  const size = { width: resize.width, height: resize.height };
  const sizeNow = useRef(size);
  sizeNow.current = size;
  useEventListener(window, "resize", () =>
    setPosition((placed) =>
      placed
        ? clampFloatingPosition(placed, sizeNow.current, { width: window.innerWidth, height: window.innerHeight })
        : placed
    ));

  // How far down it hangs before a hand has carried it anywhere: just below its switch, measured
  // because a switch stands wherever its surface put it. A layout effect settles the measurement
  // before the browser paints, so the window only ever appears where it belongs; with no switch
  // to measure it hangs from the top of the viewport.
  const [restTop, setRestTop] = useState<number | null>(null);
  const measureRest = (): void => {
    const switchBox = document.querySelector(switchSelector)?.getBoundingClientRect();
    setRestTop(switchBox ? clampFloatingTop(switchBox.bottom + SWITCH_GAP, window.innerHeight) : null);
  };
  useDomSync(measureRest, [switchSelector]);
  useEventListener(window, "resize", measureRest);

  // Carrying it by its header, the way a Bot card carries by its own: a press is a click until it
  // has travelled far enough to be a carry, and a press that began on a control belongs to that
  // control. The first carry starts from where the window already stands, so it follows the hand
  // from there instead of jumping.
  const sectionRef = useRef<HTMLElement | null>(null);
  const carry = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    from: FloatingWindowPosition;
    carrying: boolean;
  } | null>(null);
  const viewport = typeof window === "undefined"
    ? { width: 1440, height: 900 }
    : { width: window.innerWidth, height: window.innerHeight };
  const placed = position ? clampFloatingPosition(position, size, viewport) : null;
  const carriedTo = (held: NonNullable<typeof carry.current>, event: PointerEvent<HTMLDivElement>) =>
    clampFloatingPosition(
      { x: held.from.x + event.clientX - held.startX, y: held.from.y + event.clientY - held.startY },
      size,
      { width: window.innerWidth, height: window.innerHeight },
    );
  const grab = (event: PointerEvent<HTMLDivElement>): void => {
    if ((event.target as HTMLElement).closest(CONTROL)) return;
    const at = sectionRef.current?.getBoundingClientRect();
    carry.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      from: placed ?? (at ? { x: at.left, y: at.top } : { x: 0, y: 0 }),
      carrying: false,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const move = (event: PointerEvent<HTMLDivElement>): void => {
    const held = carry.current;
    if (!held || held.pointerId !== event.pointerId) return;
    if (!held.carrying) {
      if (Math.abs(event.clientX - held.startX) < MOVE_THRESHOLD && Math.abs(event.clientY - held.startY) < MOVE_THRESHOLD) return;
      held.carrying = true;
    }
    setPosition(carriedTo(held, event));
  };
  const drop = (event: PointerEvent<HTMLDivElement>): void => {
    const held = carry.current;
    if (!held || held.pointerId !== event.pointerId) return;
    carry.current = null;
    if (held.carrying) {
      const landed = carriedTo(held, event);
      setPosition(landed);
      preferences.storePosition(landed);
    }
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };

  useEventListener<KeyboardEvent>(closeOnEscape ? window : null, "keydown", (event) => {
    if (event.key === "Escape") onClose();
  });

  // On `pointerdown` rather than `click`, so a press that starts outside and ends inside still
  // closes. Menus the session portals into `document.body` are not outside: they are the window
  // acting at a distance. Neither is its own switch, which both opens and closes it: dismissing on
  // the press and toggling on the click would shut it and open it again in one gesture.
  useEventListener<globalThis.PointerEvent>(closeOnOutsidePress ? document : null, "pointerdown", (event) => {
    const target = event.target as Element | null;
    if (sectionRef.current?.contains(event.target as Node)) return;
    if (target?.closest?.(`[data-portal-menu], [role="menu"], [role="dialog"], [role="listbox"], ${switchSelector}`)) return;
    onClose();
  });

  const top = placed ? placed.y : restTop ?? 0;
  return (
    <section
      ref={sectionRef}
      id={id}
      aria-label={label}
      {...sectionProps}
      style={{
        height: resize.height,
        width: resize.width,
        // Never past the bottom of what is visible, a phone keyboard included.
        maxHeight: `calc(100dvh - ${top}px - var(--agent-panel-keyboard-inset, 0px) - 0.5rem)`,
        // Where the hand left it once carried; hanging below its switch until then. `right-0`
        // keeps the edge pinned so the width grip grows it leftwards.
        ...(placed ? { left: placed.x, top: placed.y } : { top }),
      }}
      className={`fixed z-50 flex max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-b-2xl border-x border-b border-border bg-card shadow-2xl ${
        placed ? "left-0 top-0" : "right-0 top-0"
      }`}
    >
      {/* A row rather than the header straight in the column, because the width grip hangs off
          the border the way a card's does: overlaid on the inside edge it would land on the
          transcript's scrollbar, and outside it there is nothing to grab. */}
      <div className="flex min-h-0 flex-1 flex-row">
        <div className="flex min-w-0 flex-1 flex-col">
          <div
            onPointerDown={grab}
            onPointerMove={move}
            onPointerUp={drop}
            onPointerCancel={drop}
            className="flex min-h-11 shrink-0 cursor-grab touch-none flex-wrap items-center gap-x-2 gap-y-1 border-b border-border py-1 pr-1 pl-3 select-none active:cursor-grabbing"
          >
            {header}
            <button
              type="button"
              onClick={onClose}
              aria-label={closeLabel}
              title={closeLabel}
              className="flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary active:bg-muted/80"
            >
              <X className="size-4" aria-hidden />
            </button>
          </div>
          {children}
        </div>
        {resize.edge}
      </div>
      {resize.bottom}
    </section>
  );
}
