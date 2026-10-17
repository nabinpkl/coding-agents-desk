"use client";

// The two things drawn over the video that are not the video: the scroll puck a finger
// engages the clutch with, and the mirrored cursor with its drag marks.
//
// Both are positioned and shown by direct style writes from the gesture parts rather than
// by React, so this is only the markup and the refs those writes reach through.

import type { RefObject } from "react";
import {
  DEFAULT_POINTER_SCROLL_PUCK_OFFSET,
  DRAG_PRIMING_CIRCUMFERENCE,
  DRAG_PRIMING_RADIUS,
} from "@/features/desktop-viewer/tile-viewport/tileViewportConstants";

export function PointerScrollPuck({
  keyboardPresented,
  scrollEngaged,
  scrollEngagedRef,
  scrollPuck,
  setScrollEngaged,
}: {
  keyboardPresented: boolean;
  scrollEngaged: boolean;
  scrollEngagedRef: { current: boolean };
  scrollPuck: RefObject<HTMLButtonElement | null>;
  setScrollEngaged: (engaged: boolean) => void;
}) {
  return (
    <button
      ref={scrollPuck}
      type="button"
      data-testid="pointer-scroll-puck"
      aria-label="Scroll clutch"
      aria-pressed={scrollEngaged}
      title={scrollEngaged
        ? "Scrolling: one finger scrolls at the parked pointer"
        : "Pointer: tap to make one finger scroll"}
      onClick={(event) => {
        // Keyboard and assistive-technology activation has detail=0. Physical pointers are
        // arbitrated by the delayed single/double-tap state machine installed above.
        if (event.detail === 0) setScrollEngaged(!scrollEngagedRef.current);
      }}
      style={{
        right: DEFAULT_POINTER_SCROLL_PUCK_OFFSET.right,
        bottom: `max(${DEFAULT_POINTER_SCROLL_PUCK_OFFSET.bottom}px, var(--desktop-chrome-clearance, 0px))`,
        // Hidden, never unmounted, while typing. The puck's own pointer listeners are
        // bound once by the layout effect above, whose deps do not include the keyboard;
        // a remounted puck comes back deaf, and its taps then fall through to the tile as
        // a remote click that re-arms the keyboard instead of toggling the clutch.
        ...(keyboardPresented ? { display: "none" } : {}),
      }}
      className={`absolute z-20 grid size-14 touch-none select-none place-items-center rounded-full border bg-black/45 text-white shadow-md transition-[opacity,transform,border-color] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 focus-visible:ring-offset-2 focus-visible:ring-offset-black/70 active:scale-95 motion-reduce:transition-none ${
        scrollEngaged
          ? "border-blue-400/90 opacity-90 hover:opacity-100"
          : "border-white/35 opacity-35 hover:opacity-65 focus-visible:opacity-100"
      }`}
    >
      {scrollEngaged ? (
        <svg viewBox="0 0 24 24" className="size-6" aria-hidden="true">
          <path
            d="M12 2v20M2 12h20M8.5 5.5 12 2l3.5 3.5M8.5 18.5 12 22l3.5-3.5M5.5 8.5 2 12l3.5 3.5M18.5 8.5 22 12l-3.5 3.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" className="size-6" aria-hidden="true">
          <path
            d="M5 3v15l4.2-4.2 3.2 7.2 2.6-1.2-3.2-7.1H18L5 3Z"
            fill="currentColor"
            stroke="black"
            strokeWidth="1.2"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </button>
  );
}

export function CursorOverlay({
  cursorFallback,
  cursorImage,
  cursorOverlay,
  dragHalo,
  dragPriming,
  dragPrimingArc,
}: {
  cursorFallback: RefObject<SVGSVGElement | null>;
  cursorImage: RefObject<HTMLImageElement | null>;
  cursorOverlay: RefObject<HTMLDivElement | null>;
  dragHalo: RefObject<HTMLSpanElement | null>;
  dragPriming: RefObject<HTMLSpanElement | null>;
  dragPrimingArc: RefObject<SVGCircleElement | null>;
}) {
  return (
    <div
      ref={cursorOverlay}
      data-testid="client-cursor-overlay"
      className="pointer-events-none absolute left-0 top-0 size-0 will-change-transform"
      aria-hidden="true"
    >
      <span
        ref={dragHalo}
        hidden
        data-testid="client-drag-halo"
        className="absolute -left-2.5 -top-2.5 size-5 rounded-full border-2 border-blue-400 bg-blue-400/25"
      />
      <span
        ref={dragPriming}
        hidden
        data-testid="client-drag-priming"
        className="absolute -left-3.5 -top-3.5 size-7"
      >
        <svg viewBox="0 0 28 28" className="size-full -rotate-90" aria-hidden="true">
          <circle
            cx="14"
            cy="14"
            r={DRAG_PRIMING_RADIUS}
            strokeWidth="2.5"
            className="fill-black/25 stroke-white/40"
          />
          <circle
            ref={dragPrimingArc}
            cx="14"
            cy="14"
            r={DRAG_PRIMING_RADIUS}
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeDasharray={DRAG_PRIMING_CIRCUMFERENCE}
            strokeDashoffset={DRAG_PRIMING_CIRCUMFERENCE}
            className="fill-none stroke-blue-400"
          />
        </svg>
      </span>
      <svg
        ref={cursorFallback}
        data-testid="client-cursor-fallback"
        viewBox="0 0 11 18"
        className="h-3 w-2 max-w-none overflow-visible"
        aria-hidden="true"
      >
        <path
          d="M0 0v16l4-4 3 6 2-0.8-3-6L11 11Z"
          className="fill-none stroke-blue-500 stroke-[4] [stroke-linejoin:round]"
        />
        <path
          d="M0 0v16l4-4 3 6 2-0.8-3-6L11 11Z"
          className="fill-white stroke-black stroke-[1.2] [stroke-linejoin:round]"
        />
      </svg>
      <img
        ref={cursorImage}
        alt=""
        hidden
        draggable={false}
        className="absolute left-0 top-0 max-w-none drop-shadow-[0_0_7px_var(--color-blue-500)]"
        aria-hidden="true"
      />
    </div>
  );
}
