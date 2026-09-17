// Drawing the whole canvas at once, so a reader can see the arrangement they made.
//
// The canvas is one horizontal strip that never wraps. That is deliberate and is not what this
// changes. What it costs is a reader who can only ever see a card or two of it: on a phone you
// crawl sideways across one card at a time, and there is no view in which the whole thing exists.
// This is that view, as a MODE -- with it off, nothing here renders and no transform exists in the
// tree at all, so the default canvas keeps its own pointer arithmetic byte for byte.
//
// The browser's own pinch is not available, by construction. `index.html` pins the viewport at
// `user-scalable=no, minimum-scale=1, maximum-scale=1` and `app/styles.css` locks html, body and
// #root with `overflow: hidden`, because the webview's first navigation happens at `frame: .zero`
// and an open zoom range lets WebKit settle that at a scale instead of a relayout.
// `app/viewportMeta.test.ts` asserts both spellings. So the panel does its own zoom inside a page
// whose scale never leaves 1.
//
// `transform: scale`, NOT CSS `zoom`, and the reason is this tree's rather than a general one.
// `zoom` affects layout, and `features/terminal/mounted-terminal/agentTerminalLayout.ts` derives a
// terminal's columns and rows from `mount.clientWidth` -- so a pinch would renegotiate terminal
// grids at pointer-event rate, and for a session whose pty this viewer owns that RESIZES the grid
// rather than merely redrawing it. The transcript re-pins on a ResizeObserver and the virtualiser
// re-measures every row for the same reason. A transform moves none of it: `clientWidth`,
// `offsetWidth` and `scrollWidth` are layout values an ancestor transform does not touch. The cost
// is bitmap-scaled text, which is the right trade when the whole point is to be zoomed out.
//
// The SIZER is load-bearing, and is why panning here is ordinary scrolling rather than a second
// gesture. A transform does not change `scrollWidth`, so without a wrapper sized to what is
// actually drawn, a canvas at 0.3 keeps a scroll range three times wider than anything in it and
// most of that range is empty. With one, the scroller's own range is right -- which is what keeps
// iOS momentum, and what lets the existing scroll memory go on meaning something.

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";

/**
 * What the reader chose, remembered across reloads: whether the mode is on, and how far out.
 *
 * Here rather than in `botCanvasPreferences.ts`, which is the module AGENTS.md points at and is
 * eight lines from the 500-line cap -- and splitting it needs a new file in a directory this one
 * just took to its twelve-file ceiling. Kept together rather than split across the two files to
 * fit, because the mode and the scale are one answer and one authoritative home beats two. It is
 * the same shape the rest of the panel's storage has: validate on read, try/catch on both sides,
 * written from one effect rather than beside each thing that changes it.
 *
 * Both pass the test in AGENTS.md: they are how this reader arranged the panel, they cost real
 * gestures to re-establish, and neither is invisible -- the sidebar's toggle says which way the
 * mode is, and a canvas drawn at a third of its size is not something a reader can overlook.
 */
const ZOOM_MODE_KEY = "agent-panel.bot-canvas.zoom-mode";
const ZOOM_SCALE_KEY = "agent-panel.bot-canvas.zoom-scale";

/**
 * The smallest scale that can be STORED, which is not the smallest that can be drawn. The floor a
 * gesture stops at is fit-to-content, computed against the strip and the panel; this only has to
 * sit below any fit worth having. It doubles as the default, so a mode that has never been pinched
 * opens whole: `clampZoom` raises anything under fit back up to it.
 */
export const MIN_CANVAS_ZOOM = 0.02;

export function loadCanvasZoomMode(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return localStorage.getItem(ZOOM_MODE_KEY) === "on";
  } catch {
    return false;
  }
}

export function storeCanvasZoomMode(on: boolean): void {
  try {
    if (on) localStorage.setItem(ZOOM_MODE_KEY, "on");
    else localStorage.removeItem(ZOOM_MODE_KEY);
  } catch {
    // The canvas still zooms; it just opens at its own size next time.
  }
}

/** Checked rather than cast, so a stale or hand-edited value opens the canvas at fit instead of at
 *  some scale no gesture can undo. */
export function loadCanvasZoomScale(): number {
  if (typeof window === "undefined") return MIN_CANVAS_ZOOM;
  try {
    const raw = localStorage.getItem(ZOOM_SCALE_KEY);
    const parsed = raw === null ? NaN : Number(raw);
    return storable(parsed) ? parsed : MIN_CANVAS_ZOOM;
  } catch {
    return MIN_CANVAS_ZOOM;
  }
}

export function storeCanvasZoomScale(scale: number): void {
  try {
    if (storable(scale)) localStorage.setItem(ZOOM_SCALE_KEY, String(scale));
    else localStorage.removeItem(ZOOM_SCALE_KEY);
  } catch {
    // The canvas still zooms; it just opens at fit next time.
  }
}

function storable(scale: number): boolean {
  return Number.isFinite(scale) && scale >= MIN_CANVAS_ZOOM && scale <= 1;
}

/** How far inside the scroller a card lands when a press zooms to it, so it is not flush. */
const CARD_INSET = 12;

/**
 * A trackpad pinch arrives as a ctrl-wheel of much smaller deltas than a mouse wheel's notch, so
 * it gets a rate of its own rather than sharing one and moving a tenth as fast.
 */
const TRACKPAD_RATE = 0.01;

interface Size {
  width: number;
  height: number;
}

/**
 * The largest scale at which the whole strip fits, never above 1.
 *
 * Capped at 1 because this mode only zooms OUT: the ceiling is the size the canvas already draws
 * at, and a canvas that already fits has nothing to do. Unmeasured returns 1 for the same reason a
 * missing answer should never be a magnifying one.
 */
export function fitScale(content: Size, viewport: Size): number {
  if (!(content.width > 0) || !(content.height > 0)) return 1;
  if (!(viewport.width > 0) || !(viewport.height > 0)) return 1;
  return Math.min(1, viewport.width / content.width, viewport.height / content.height);
}

/**
 * A scale held between fit and 1:1.
 *
 * The floor is `fit` rather than a constant, which is what makes "out only, down to fit" true
 * however many cards are on the canvas -- and what makes the smallest storable number resolve to
 * fit, so a mode that has never been pinched opens whole.
 */
export function clampZoom(scale: number, fit: number): number {
  if (!Number.isFinite(scale)) return fit;
  return Math.min(1, Math.max(fit, scale));
}

/** No room at all, held once so the gutter being off hands back the same object every render. */
const NO_ROOM = { left: 0, top: 0 };

/**
 * Where the scroller has to be so that whatever is under the pointer stays under it.
 *
 * The whole of the zoom arithmetic, and the difference between a gesture that feels like grabbing
 * the canvas and one that makes a reader chase the card they were already pointing at. `pointerX`
 * and `pointerY` are relative to the scroller's own top-left, not the page's.
 *
 * `padLeft` and `padTop` are the room around the canvas, which is the distance between the
 * scroller's origin and the canvas's own. Everything else here is in content coordinates, so a
 * gesture that forgot the room would hold a point half a panel away from the reader's fingers.
 */
export function focalScroll(
  at: {
    scrollLeft: number;
    scrollTop: number;
    pointerX: number;
    pointerY: number;
    padLeft: number;
    padTop: number;
  },
  from: number,
  to: number,
): { left: number; top: number } {
  if (!(from > 0) || !(to > 0)) return { left: at.scrollLeft, top: at.scrollTop };
  const contentX = (at.scrollLeft + at.pointerX - at.padLeft) / from;
  const contentY = (at.scrollTop + at.pointerY - at.padTop) / from;
  return {
    left: Math.max(0, contentX * to + at.padLeft - at.pointerX),
    top: Math.max(0, contentY * to + at.padTop - at.pointerY),
  };
}

/**
 * Which card a press landed on, by x alone: the strip is one row that never wraps, so x is the
 * whole address. Screen coordinates, because that is the one space where the boxes and the press
 * are already in the same units and no conversion can be got wrong. -1 for a press beside them.
 */
export function cardUnder(cards: readonly { left: number; right: number }[], x: number): number {
  return cards.findIndex((card) => x >= card.left && x < card.right);
}

/**
 * What an element is actually drawn at, measured off the element rather than passed down to it.
 *
 * Measured because the alternative is threading one number through four components and every
 * consumer remembering to divide by it; this is correct by construction instead, for any ancestor
 * transform, including none.
 *
 * Snapped to exactly 1 near 1, and that guard is the point rather than tidiness: `offsetWidth` is a
 * rounded integer where the rect is not, so an element with no transform over it measures a
 * fraction of a percent off. Applied to a drag delta that fraction is drift in a path that has
 * none today, and the mode being OFF has to divide by exactly one.
 */
export function effectiveScale(node: HTMLElement | null): number {
  if (!node) return 1;
  const laid = node.offsetWidth;
  if (laid <= 0) return 1;
  const ratio = node.getBoundingClientRect().width / laid;
  if (!Number.isFinite(ratio) || ratio <= 0) return 1;
  return Math.abs(ratio - 1) < 0.01 ? 1 : ratio;
}

export interface CanvasZoom {
  /** Whether the mode is on. False means every style below is undefined and no wrapper renders. */
  on: boolean;
  /** What the strip is drawn at. Exactly 1 whenever the mode is off, or before it has measured. */
  scale: number;
  /** Whether the strip and the scroller have been measured, so `scale` means something yet. */
  measured: boolean;
  /**
   * The room around the canvas, in scroller pixels, and so the distance between the scroller's
   * own origin and the canvas's. Zero on both axes while the mode is off.
   *
   * Handed out because an offset into this scroller is no longer an offset into the canvas, and
   * everything that converts between the two -- the remembered place, most of all -- has to say
   * which of them it means.
   */
  pad: { left: number; top: number };
  /**
   * The wrapper that gives the scroller the range the transform does not.
   *
   * Never undefined, because the wrapper is never removed. It carries `display: contents` while the
   * mode is off, which generates no box at all, so the strip is laid out exactly as though it were
   * still the scroller's own child. Conditionally rendering the wrapper instead looks tidier and
   * is a serious bug: it moves the strip in the tree, so React unmounts it and mounts a new one --
   * which detaches the element the ResizeObserver is watching, and, far worse, remounts every open
   * session card inside it, tearing down every live stream on the canvas on each toggle.
   */
  sizerStyle: CSSProperties;
  stripStyle: CSSProperties | undefined;
  scrollerStyle: CSSProperties | undefined;
}

function unchanged(was: Size, width: number, height: number): boolean {
  return was.width === width && was.height === height;
}

function spread(touches: TouchList): number {
  const first = touches[0];
  const second = touches[1];
  if (!first || !second) return 0;
  return Math.hypot(first.clientX - second.clientX, first.clientY - second.clientY);
}

export function useCanvasZoom({
  scroller,
  strip,
  on,
  room,
}: {
  scroller: React.RefObject<HTMLDivElement | null>;
  strip: React.RefObject<HTMLUListElement | null>;
  on: boolean;
  /**
   * How much room the canvas is given to be scrolled around in, in pixels on every side. Zero is
   * the default and means the canvas sits against the corner. See `CANVAS_ROOM_STEPS` for what
   * the sizes are and why the smallest useful one is small.
   */
  room: number;
}): CanvasZoom {
  const [wanted, setWanted] = useState(loadCanvasZoomScale);
  const [content, setContent] = useState<Size>({ width: 0, height: 0 });
  const [viewport, setViewport] = useState<Size>({ width: 0, height: 0 });
  const measured = content.width > 0 && viewport.width > 0;
  const fit = fitScale(content, viewport);
  const scale = on && measured ? clampZoom(wanted, fit) : 1;

  // A gesture reads the scale and the floor it is continuing, and must not wait for a render to
  // find out where the last event left them.
  const drawn = useRef(scale);
  drawn.current = scale;
  const floor = useRef(fit);
  floor.current = fit;

  // The gutter the canvas is scrolled around in. The reader's own number rather than anything
  // derived from the scale, so it does not move under a pinch: the canvas grows and shrinks
  // inside a border that stays put.
  const gutter = on && measured && room > 0 ? { left: room, top: room } : NO_ROOM;
  const gap = useRef(gutter);
  gap.current = gutter;

  // Where the next paint has to leave the scroller, set by whatever changed the scale and applied
  // once the sizer has resized. In a layout effect so the reader never sees the frame where the
  // strip has changed size and the scroller has not caught up with it.
  const landing = useRef<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const box = scroller.current;
    const at = landing.current;
    landing.current = null;
    if (!box || !at) return;
    box.scrollLeft = at.left;
    box.scrollTop = at.top;
  });

  // The gutter appearing or going away moves the canvas inside the scroller, so the scroller moves
  // with it and the reader sees nothing happen. Without this, turning it on drops room in ahead of
  // a scroller already somewhere and the canvas lurches by exactly that much. The restore on mount
  // sets an absolute offset AFTER this runs, so the two never double up.
  const applied = useRef(gutter);
  useLayoutEffect(() => {
    const box = scroller.current;
    const was = applied.current;
    applied.current = gutter;
    if (!box || (was.left === gutter.left && was.top === gutter.top)) return;
    box.scrollLeft += gutter.left - was.left;
    box.scrollTop += gutter.top - was.top;
  }, [scroller, gutter.left, gutter.top]);

  // One write for the scale, from an effect on the value rather than beside each of the gestures
  // that move it, which is how one of them ends up forgotten.
  useEffect(() => storeCanvasZoomScale(wanted), [wanted]);

  useEffect(() => {
    if (!on) {
      // Dropped rather than kept, so turning the mode back on measures the canvas it is turned on
      // over rather than the one it was last turned off over.
      setContent({ width: 0, height: 0 });
      setViewport({ width: 0, height: 0 });
      return;
    }
    const strand = strip.current;
    const box = scroller.current;
    if (!strand || !box) return;
    // Layout values on both sides: `offsetWidth` is what the strip WOULD occupy, so the strip's
    // own transform does not perturb the number the transform is computed from.
    const measure = () => {
      // A detached node measures zero, and zero here would clear `measured`, drop the sizer and
      // undo the very layout being measured. It cannot happen now that the wrapper is permanent,
      // and it is guarded anyway because the failure it caused was invisible: the observer went on
      // reporting about an element no longer in the page, and the canvas simply never drew small.
      if (!strand.isConnected) return;
      setContent((was) =>
        unchanged(was, strand.offsetWidth, strand.offsetHeight)
          ? was
          : { width: strand.offsetWidth, height: strand.offsetHeight });
      setViewport((was) =>
        unchanged(was, box.clientWidth, box.clientHeight)
          ? was
          : { width: box.clientWidth, height: box.clientHeight });
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(strand);
    observer.observe(box);
    return () => observer.disconnect();
  }, [on, scroller, strip]);

  const zoomTo = useCallback((next: number, clientX?: number, clientY?: number) => {
    const box = scroller.current;
    if (!box) return;
    const from = drawn.current;
    const to = clampZoom(next, floor.current);
    if (to === from) return;
    const rect = box.getBoundingClientRect();
    landing.current = focalScroll({
      scrollLeft: box.scrollLeft,
      scrollTop: box.scrollTop,
      pointerX: (clientX ?? rect.left + rect.width / 2) - rect.left,
      pointerY: (clientY ?? rect.top + rect.height / 2) - rect.top,
      padLeft: gap.current.left,
      padTop: gap.current.top,
    }, from, to);
    setWanted(to);
  }, [scroller]);

  useEffect(() => {
    const box = scroller.current;
    const strand = strip.current;
    if (!on || !box || !strand) return;

    // A trackpad pinch arrives as a wheel with ctrlKey set, and that is the only wheel this takes.
    // A plain wheel goes on scrolling the canvas, because panning is what a scroller's wheel means
    // and panning is most of what this mode is for.
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      // Wheels do not all speak pixels: a line-mode wheel reports about 3 and a page-mode one
      // about 1, and reading either as pixels makes the gesture do nothing at all.
      const lines = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? box.clientHeight : 1;
      zoomTo(drawn.current * Math.exp(-event.deltaY * lines * TRACKPAD_RATE), event.clientX, event.clientY);
    };

    // Two fingers are the pinch, and the gesture is taken from the browser only while two are
    // down. One finger stays native scrolling, which is what keeps the strip's momentum and its
    // overscroll rather than reimplementing both badly.
    let began = 0;
    let from = 1;
    const onTouchStart = (event: TouchEvent) => {
      began = event.touches.length === 2 ? spread(event.touches) : 0;
      from = drawn.current;
    };
    const onTouchMove = (event: TouchEvent) => {
      if (event.touches.length !== 2 || began <= 0) return;
      // Non-passive, so this can stop the browser scrolling the canvas out from under the pinch.
      event.preventDefault();
      const first = event.touches[0]!;
      const second = event.touches[1]!;
      zoomTo(
        from * (spread(event.touches) / began),
        (first.clientX + second.clientX) / 2,
        (first.clientY + second.clientY) / 2,
      );
    };
    const onTouchEnd = (event: TouchEvent) => {
      if (event.touches.length < 2) began = 0;
    };

    // A press that reaches the scroller rather than a card, which is the empty canvas AROUND the
    // strip: beside it, and below it, where a canvas drawn small leaves most of the panel empty.
    //
    // The strip itself is a hit-test target at every scale, so a press on a card belongs to the
    // card and never to the canvas. That is deliberate -- the cards are the reader's at any size
    // -- and it leaves this the whole of the way in and out on a surface carrying no chrome.
    const onClick = (event: MouseEvent) => {
      if (strand.contains(event.target as Node)) return;
      const rect = box.getBoundingClientRect();
      // Already at its own size, so there is nothing left to zoom into and the press means the
      // other direction. This is the way back out on a surface that carries no chrome of its own.
      if (drawn.current >= 1) {
        zoomTo(floor.current, event.clientX, event.clientY);
        return;
      }
      const boxes = [...strand.children].map((child) => child.getBoundingClientRect());
      const index = cardUnder(boxes, event.clientX);
      const card = boxes[index];
      if (!card) {
        zoomTo(1, event.clientX, event.clientY);
        return;
      }
      // Straight to the card that was aimed at, rather than to whatever happened to be under the
      // middle of the screen. The target scale is 1, so a content coordinate is a scroll offset
      // once the room around the canvas is added back to it.
      landing.current = {
        left: Math.max(0, (box.scrollLeft + card.left - rect.left - gap.current.left) / drawn.current
          + gap.current.left - CARD_INSET),
        top: Math.max(0, (box.scrollTop + card.top - rect.top - gap.current.top) / drawn.current
          + gap.current.top - CARD_INSET),
      };
      setWanted(1);
    };

    box.addEventListener("wheel", onWheel, { passive: false });
    box.addEventListener("touchstart", onTouchStart, { passive: true });
    box.addEventListener("touchmove", onTouchMove, { passive: false });
    box.addEventListener("touchend", onTouchEnd, { passive: true });
    box.addEventListener("touchcancel", onTouchEnd, { passive: true });
    box.addEventListener("click", onClick);
    return () => {
      box.removeEventListener("wheel", onWheel);
      box.removeEventListener("touchstart", onTouchStart);
      box.removeEventListener("touchmove", onTouchMove);
      box.removeEventListener("touchend", onTouchEnd);
      box.removeEventListener("touchcancel", onTouchEnd);
      box.removeEventListener("click", onClick);
    };
  }, [on, scroller, strip, zoomTo]);

  return {
    on,
    scale,
    measured,
    pad: gutter,
    // The gutter is the sizer's own padding rather than a translate on the strip, which keeps the
    // rule below true: while the canvas is drawn at its own size there is no transform in the
    // tree at all, and so no containing block stolen from anything `position: fixed` inside a
    // card. `border-box`, so the width quoted here is the whole box including that padding.
    sizerStyle: on && measured
      ? {
        width: content.width * scale + gutter.left * 2,
        height: content.height * scale + gutter.top * 2,
        paddingLeft: gutter.left,
        paddingTop: gutter.top,
        boxSizing: "border-box",
      }
      : { display: "contents" },
    // No transform at exactly 1:1, where the mode has nothing to draw differently. Not tidiness:
    // a `scale(1)` is still a transform, and a transform is still a containing block for every
    // `position: fixed` under it, so emitting one there would move things for no gain.
    stripStyle: on && scale !== 1
      ? { transform: `scale(${scale})`, transformOrigin: "0 0" }
      : undefined,
    // `pan-x pan-y` keeps one-finger scrolling native while telling the browser this page handles
    // its own pinch, which is what lets both touches go on reaching the listeners above.
    scrollerStyle: on ? { touchAction: "pan-x pan-y" } : undefined,
  };
}
