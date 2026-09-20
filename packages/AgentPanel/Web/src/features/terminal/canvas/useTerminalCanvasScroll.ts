// Opening the terminal strip where the reader left it, and keeping saying where that is.
//
// The Bot canvas's `useRememberedCanvasScroll` narrowed to what this strip needs: the offset is
// stored in CONTENT space so it keeps naming the same cards at any zoom scale, divided by the
// scale on the way out and multiplied back on the way in -- which is why the restore waits for
// the zoom to be measured before firing. What stays is the shape that made the Bot one work: a
// restore that holds while the strip is still growing under it, a throttled write, and one final
// write on the way out.
//
// Its own key rather than the Bot canvas's, because the two strips are different places: an
// offset on one names nothing on the other, and sharing the store would land each canvas where
// the other was left.
//
// A phone keyboard moves this scroller without the reader: focusing a tile scrolls it into the
// shrunken viewport, and the shortening document clamps whatever was already scrolled. Those
// scrolls are the browser's, so they are neither stored (below) nor kept (the close effect) --
// without both, a zoomed canvas stops showing what it showed before the keyboard came up.

import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { keyboardInset, typesText } from "@/app/page/keyboardInset";

const SCROLL_KEY = "agent-panel.terminal-canvas.scroll";
const SCROLL_SETTLE_MS = 200;
const RESTORE_HOLD_MS = 1500;

interface StripScroll {
  left: number;
  top: number;
}

function loadStripScroll(): StripScroll {
  if (typeof window === "undefined") return { left: 0, top: 0 };
  try {
    const raw = localStorage.getItem(SCROLL_KEY);
    if (!raw) return { left: 0, top: 0 };
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return { left: 0, top: 0 };
    const { left, top } = parsed as Partial<StripScroll>;
    return {
      left: typeof left === "number" && Number.isFinite(left) ? left : 0,
      top: typeof top === "number" && Number.isFinite(top) ? top : 0,
    };
  } catch {
    return { left: 0, top: 0 };
  }
}

function storeStripScroll(scroll: StripScroll): void {
  try {
    if (scroll.left === 0 && scroll.top === 0) localStorage.removeItem(SCROLL_KEY);
    else {
      localStorage.setItem(SCROLL_KEY, JSON.stringify({
        left: Math.round(scroll.left),
        top: Math.round(scroll.top),
      }));
    }
  } catch {
    // The strip still scrolls; it just opens at the left edge next time.
  }
}

/**
 * Whether a software keyboard is covering the page right now.
 *
 * The same rule the document inset is published from (`app/page/keyboardInset`): a focused text
 * field plus a visual viewport shrunk by at least a keyboard's worth. Recomputed from the raw
 * inputs rather than read back off the published variable, so the answer is the one in force at
 * the moment a scroll event fires rather than whenever the inset writer's own listener ran.
 */
function keyboardCovering(): boolean {
  if (typeof window === "undefined" || typeof document === "undefined") return false;
  const viewport = window.visualViewport;
  return keyboardInset({
    layoutHeight: window.innerHeight,
    viewportHeight: viewport?.height ?? window.innerHeight,
    viewportOffsetTop: viewport?.offsetTop ?? 0,
    typing: typesText(document.activeElement),
  }) > 0;
}

export function useTerminalCanvasScroll(
  scroller: React.RefObject<HTMLDivElement | null>,
  /** Whatever changing means the strip may have grown: re-checks the restore on it. */
  content: unknown,
  /**
   * What the strip is drawn at, and whether that is settled yet.
   *
   * With the zoom mode off the scale is 1 with no pad and the restore fires on the first layout
   * with somewhere to scroll to; with it on, the restore waits for the strip and the panel to be
   * measured, or an offset taken at one scale would land wherever it happens to point at another.
   */
  zoom: { scale: number; ready: boolean; pad: { left: number; top: number } } = {
    scale: 1,
    ready: true,
    pad: { left: 0, top: 0 },
  },
): () => void {
  const restored = useRef(false);
  const wanted = useRef<StripScroll | null>(null);
  const latest = useRef<StripScroll | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Whether a restore is still asking for its offset; its scrolls are not the reader's. */
  const holding = useRef(false);

  useLayoutEffect(() => {
    if (restored.current || !zoom.ready) return;
    const el = scroller.current;
    if (!el) return;
    wanted.current ??= loadStripScroll();
    const { left, top } = wanted.current;
    if (left === 0 && top === 0 && zoom.pad.left === 0 && zoom.pad.top === 0) {
      restored.current = true;
      return;
    }
    if (el.scrollWidth <= el.clientWidth && el.scrollHeight <= el.clientHeight) {
      // Nothing to scroll yet -- unless the zoom mode has drawn the strip whole, in which case
      // the canvas fits and always will at this scale. Leaving the restore pending there would
      // fire it later, at the moment a pinch first gives the scroller some range.
      if (zoom.scale < 1) restored.current = true;
      return;
    }
    restored.current = true;
    const asked = { left: left * zoom.scale + zoom.pad.left, top: top * zoom.scale + zoom.pad.top };
    el.scrollLeft = asked.left;
    el.scrollTop = asked.top;
    // Landing short is the strip not reaching that far YET -- tiles mount and measure after the
    // listing -- so the offset is held and re-applied until it does. No hold when it landed:
    // the strip only grows, so an offset that fits keeps fitting.
    if (el.scrollLeft >= asked.left - 1 && el.scrollTop >= asked.top - 1) return;
    holding.current = true;
    const held = asked;
    let frame = requestAnimationFrame(function again() {
      el.scrollLeft = held.left;
      el.scrollTop = held.top;
      frame = requestAnimationFrame(again);
    });
    const release = (): void => {
      holding.current = false;
      cancelAnimationFrame(frame);
      clearTimeout(timeout);
    };
    const timeout = setTimeout(release, RESTORE_HOLD_MS);
    // Fighting a reader who is already scrolling is worse than landing short.
    el.addEventListener("wheel", release, { passive: true });
    el.addEventListener("touchstart", release, { passive: true });
    el.addEventListener("pointerdown", release, { passive: true });
    return () => {
      release();
      el.removeEventListener("wheel", release);
      el.removeEventListener("touchstart", release);
      el.removeEventListener("pointerdown", release);
    };
  }, [scroller, content, zoom.ready, zoom.scale, zoom.pad.left, zoom.pad.top]);

  // Whether the keyboard was covering the last time anything looked. Shared by the scroll
  // handler below and the close watcher after it: a keyboard that opens with no subscribed
  // signal before its first scroll -- focus scrolling fires no resize -- is still noticed, because
  // that scroll itself marks it.
  const wasCovering = useRef<boolean>(false);

  const remember = useCallback(() => {
    const el = scroller.current;
    // A hold is the restore still arriving rather than the reader moving: writing one of those
    // down is how the remembered place walks away from the reader a little further every visit.
    if (!el || !restored.current || holding.current) return;
    const covering = keyboardCovering();
    wasCovering.current = covering;
    // A scroll while the keyboard is up is the browser's, not the reader's: focusing a tile
    // scrolls it into the shrunken viewport, and the shortening document clamps whatever was
    // already scrolled. Writing either down is how the zoomed canvas stops showing what it
    // showed before the keyboard came up -- so neither is stored, judged at event time so a
    // settle timer firing after the keyboard closed cannot launder one in. The pre-keyboard
    // offset stays the truth, and the close effect below puts it back on screen.
    if (covering) return;
    // Back into content space on the way out, so a position taken while zoomed out still names
    // the card it was taken over once the canvas is drawn at some other size.
    latest.current = {
      left: (el.scrollLeft - zoom.pad.left) / zoom.scale,
      top: (el.scrollTop - zoom.pad.top) / zoom.scale,
    };
    if (timer.current !== null) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      if (latest.current) storeStripScroll(latest.current);
    }, SCROLL_SETTLE_MS);
  }, [scroller, zoom.scale, zoom.pad.left, zoom.pad.top]);

  // Puts the canvas back where it was once the keyboard is gone. The browser restores neither
  // the offset its own scroll-into-view moved nor what the shortened document clamped, and the
  // scrolls above were deliberately not stored -- so without this the canvas keeps the
  // keyboard-era offset until the reader drags it back by hand. One shot rather than a hold:
  // the strip is the same size it was, so an offset that fitted before fits again. Skipped
  // while the mount restore still owns the offset, and while there is nothing to put back.
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  useEffect(() => {
    wasCovering.current = keyboardCovering();
    const onChange = (): void => {
      const covering = keyboardCovering();
      const closed = wasCovering.current && !covering;
      wasCovering.current = covering;
      if (!closed) return;
      const el = scroller.current;
      const at = latest.current ?? wanted.current;
      if (!el || !restored.current || holding.current || !at) return;
      if (at.left === 0 && at.top === 0 && zoomRef.current.pad.left === 0 && zoomRef.current.pad.top === 0) return;
      el.scrollLeft = at.left * zoomRef.current.scale + zoomRef.current.pad.left;
      el.scrollTop = at.top * zoomRef.current.scale + zoomRef.current.pad.top;
    };
    // The same signals the inset writer listens to: the viewport says how much is covered, and
    // focus says whether anything is typing into it -- blur usually lands before the viewport
    // has finished growing back, so either one alone misses an end of the transition.
    const viewport = window.visualViewport;
    viewport?.addEventListener("resize", onChange);
    viewport?.addEventListener("scroll", onChange);
    window.addEventListener("resize", onChange);
    document.addEventListener("focusin", onChange);
    document.addEventListener("focusout", onChange);
    return () => {
      viewport?.removeEventListener("resize", onChange);
      viewport?.removeEventListener("scroll", onChange);
      window.removeEventListener("resize", onChange);
      document.removeEventListener("focusin", onChange);
      document.removeEventListener("focusout", onChange);
    };
  }, [scroller]);

  useEffect(() => () => {
    if (timer.current !== null) clearTimeout(timer.current);
    if (latest.current) storeStripScroll(latest.current);
  }, []);

  return remember;
}
