"use client";

// The trackpad deck: a pad that drives the Mac's pointer and a strip that scrolls it, under the
// picture, as the iPhone client's "As Is" layout put them.
//
// It is a second way into the same pointer, not a second pointer: both controls drive the
// viewer's one `PointerInputSession`, so the cursor drawn on the picture moves with the pad, a
// held button on the pad is the same held button the picture would hold, and a strip touch stops
// a coast the puck started.

import { useRef, useState } from "react";
import { MouseRight, SlidersHorizontal } from "lucide-react";
import { GestureTuningPanel } from "@/features/desktop-viewer/trackpad/GestureTuningPanel";
import type { PointerInputSession } from "@/features/desktop-viewer/pointer-input/pointerInputSession";
import { WHEEL_SCROLL_IDLE_MS } from "@/features/desktop-viewer/tile-viewport/tileViewportConstants";
import {
  SCROLL_STRIP_HIT_OUTSET,
  SCROLL_STRIP_RADIUS,
  SCROLL_STRIP_WIDTH,
  TRACKPAD_HIT_OUTSET,
  TRACKPAD_STRIP_GAP,
} from "@/features/desktop-viewer/trackpad/trackpadConstants";
import { useScrollStripGestures } from "@/features/desktop-viewer/trackpad/useScrollStripGestures";
import { useTrackpadGestures } from "@/features/desktop-viewer/trackpad/useTrackpadGestures";
import { useLeaveEffect } from "@/hooks/useMountEffect";

export function TrackpadDeck({
  input,
  height,
  disabled = false,
  beforeClick,
}: {
  input: PointerInputSession;
  height: number;
  /** No control channel yet: the deck is drawn but takes nothing. */
  disabled?: boolean;
  beforeClick?: () => string | undefined;
}) {
  const pad = useRef<HTMLDivElement>(null);
  const strip = useRef<HTMLDivElement>(null);
  const [held, setHeld] = useState(false);
  const [tuning, setTuning] = useState(false);
  const wheelIdle = useRef(0);

  // A Mac trackpad's two-finger scroll over the deck reaches here as a wheel. It is already the
  // scroll the OS decided on, so it goes out as it is, and its end is the quiet after it.
  const wheel = (event: WheelEvent) => {
    const scroll = input.translator.scroll;
    scroll.wheelScroll(-event.deltaX, -event.deltaY);
    window.clearTimeout(wheelIdle.current);
    wheelIdle.current = window.setTimeout(() => {
      wheelIdle.current = 0;
      scroll.wheelEnd();
    }, WHEEL_SCROLL_IDLE_MS);
  };
  // A wheel still scrolling ends with the input it was scrolling.
  useLeaveEffect(input, () => {
    if (wheelIdle.current === 0) return;
    window.clearTimeout(wheelIdle.current);
    input.translator.scroll.wheelEnd();
  });

  useTrackpadGestures(pad, { input, beforeClick, onHeld: setHeld, onWheel: wheel });
  useScrollStripGestures(strip, { input, onWheel: wheel });

  return (
    <div
      data-testid="trackpad-deck"
      role="group"
      aria-label="Trackpad"
      aria-disabled={disabled}
      style={{ height }}
      className={`relative flex flex-col gap-2 bg-black px-3 pt-2 ${disabled ? "pointer-events-none opacity-50" : ""}`}
    >
      <div className="flex min-h-0 flex-1" style={{ gap: TRACKPAD_STRIP_GAP }}>
        <div
          ref={pad}
          data-testid="trackpad-pad"
          data-held={held ? "" : undefined}
          aria-label="Trackpad surface"
          className="relative min-w-0 flex-1 touch-none select-none rounded-2xl border border-white/15
            bg-white/[0.06] transition-colors duration-150 motion-reduce:transition-none
            data-[held]:border-blue-400 data-[held]:bg-blue-400/15"
        >
          {/* Extra hit area past the edge, so a swipe that lands in the gutter still counts. */}
          <span aria-hidden className="absolute inset-y-0 right-full" style={{ width: TRACKPAD_HIT_OUTSET }} />
        </div>
        <div
          ref={strip}
          data-testid="trackpad-scroll-strip"
          aria-label="Scroll strip"
          className="relative flex touch-none select-none items-center justify-center border border-white/15 bg-white/[0.1]
            text-white/40"
          style={{ width: SCROLL_STRIP_WIDTH, borderRadius: SCROLL_STRIP_RADIUS }}
        >
          <svg viewBox="0 0 24 24" className="pointer-events-none size-5" aria-hidden="true">
            <path d="M12 4v16M8 8l4-4 4 4M8 16l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.8"
              strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span aria-hidden className="absolute inset-y-0 left-full" style={{ width: SCROLL_STRIP_HIT_OUTSET }} />
        </div>
      </div>
      {tuning ? (
        <div className="absolute inset-x-3 bottom-12 z-10">
          <GestureTuningPanel onClose={() => setTuning(false)} />
        </div>
      ) : null}
      <div className="flex justify-between gap-2">
        <button
          type="button"
          aria-pressed={tuning}
          onClick={() => setTuning((open) => !open)}
          className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[11px] text-white/75 transition-colors
            hover:bg-white/10 active:bg-white/15 aria-pressed:bg-white aria-pressed:text-black focus-visible:outline-2
            focus-visible:-outline-offset-2 focus-visible:outline-white motion-reduce:transition-none"
        >
          <SlidersHorizontal className="size-3.5" aria-hidden />
          Tuning
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => input.translator.tap("right")}
          className="flex items-center gap-1.5 rounded-md bg-white/10 px-3 py-1.5 text-[11px] text-white/85
            transition-colors hover:bg-white/15 active:bg-white/25 focus-visible:outline-2
            focus-visible:-outline-offset-2 focus-visible:outline-white disabled:cursor-not-allowed disabled:opacity-50
            motion-reduce:transition-none"
        >
          <MouseRight className="size-3.5" aria-hidden />
          Right click
        </button>
      </div>
    </div>
  );
}
