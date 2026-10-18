"use client";

// The picture-mode buttons in the viewer's bar, and the resolution slider in its settings popover,
// with the readout of what the knob actually asks for.

import { useState } from "react";
import { CAPTURE_SCALE_MAX, CAPTURE_SCALE_MIN } from "@/features/desktop-viewer/tile-stream/TileStreamRtc";
import { getCaptureScale, setCaptureScale } from "@/features/desktop-viewer/zoom/captureScale";
import { useTimeout } from "@/hooks/useInterval";

/**
 * How long the resolution knob has to sit still before the stream is asked to change.
 *
 * A range input reports every step it passes through, and each distinct value renegotiates the
 * connection and replaces the encoder behind it. Dragging from one end to the other would otherwise
 * spawn and retire a capture per step, which is both wasteful and the surest way to provoke the
 * teardown race. The label still follows the thumb; only the request waits.
 */
const CAPTURE_SCALE_SETTLE_MS = 400;

export function ModeButton({
  active,
  disabled = false,
  label,
  icon,
  onClick,
}: {
  active: boolean;
  disabled?: boolean;
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[11px] transition-colors
        focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-white
        disabled:cursor-wait disabled:opacity-50
        ${active ? "bg-white text-black" : "text-white/75 hover:bg-white/10 active:bg-white/15"}`}
    >
      {icon}
      {/* Below a phone's width the bar keeps one row by dropping the words, never by wrapping;
          the label stays as the button's name. */}
      <span className="sr-only @min-[22rem]:not-sr-only">{label}</span>
    </button>
  );
}

/** Best-effort readout of what the current knob asks the encoder for, capped at source-native. */
export function encodedCaptureSize(sourceWidth: number, sourceHeight: number, scale: number): string {
  const capped = Math.min(1, scale);
  return `${Math.round(sourceWidth * capped)}×${Math.round(sourceHeight * capped)}`;
}

export function ResolutionSlider({
  sourceWidth,
  sourceHeight,
}: {
  sourceWidth?: number;
  sourceHeight?: number;
}) {
  // The slider owns the value while it is being moved, and reports only where it came to rest.
  //
  // Lifting every intermediate step re-rendered the whole viewer -- video element included -- once
  // per step, and a controlled range whose parent re-renders that heavily loses the race with the
  // pointer: React writes a now-stale value back into the DOM mid-drag and the thumb snaps, usually
  // toward whichever end the drag was heading for. Keeping the drag local means one cheap re-render
  // per step here, and one renegotiation when it settles.
  // Seeded from the store and owned here while it moves; the store hears only where it came to
  // rest. Deliberately not subscribed: this control is the one writing, and re-rendering it from
  // its own write would fight the pointer mid-drag.
  const [draft, setDraft] = useState(getCaptureScale);
  useTimeout(() => setCaptureScale(draft), draft === getCaptureScale() ? null : CAPTURE_SCALE_SETTLE_MS, draft);
  const encoded = sourceWidth && sourceHeight
    ? encodedCaptureSize(sourceWidth, sourceHeight, draft)
    : null;
  return (
    // Deliberately not a <label> wrapping the input. A label forwards a press anywhere inside it to
    // the control, so pressing the word or the readout dispatched a click on the range -- and the
    // readout sits at the right end, so it landed on the maximum every time.
    <div
      className="flex items-center gap-2 px-2 text-[11px] text-white/75"
      title={encoded ? `Capture resolution ${encoded} (${draft.toFixed(2)}×)` : "Capture resolution"}
    >
      <span aria-hidden className="w-16 shrink-0 text-white/60">Resolution</span>
      <input
        type="range"
        min={CAPTURE_SCALE_MIN}
        max={CAPTURE_SCALE_MAX}
        step={0.25}
        value={draft}
        onChange={(event) => setDraft(Number.parseFloat(event.target.value))}
        aria-label="Capture resolution"
        aria-valuetext={encoded ? `${encoded}, ${draft.toFixed(2)} times` : `${draft.toFixed(2)} times`}
        // `appearance-none` also removes the thumb, so it is drawn back explicitly -- without it
        // there is no grab target and the only way to change the value is to click the track.
        className="h-1 min-w-0 flex-1 cursor-pointer appearance-none rounded-full bg-white/25 outline-none
          focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white
          [&::-webkit-slider-thumb]:size-3 [&::-webkit-slider-thumb]:appearance-none
          [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white
          [&::-moz-range-thumb]:size-3 [&::-moz-range-thumb]:rounded-full
          [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-white"
      />
      <span className="w-9 tabular-nums text-right text-white/60">{draft.toFixed(2)}×</span>
    </div>
  );
}
