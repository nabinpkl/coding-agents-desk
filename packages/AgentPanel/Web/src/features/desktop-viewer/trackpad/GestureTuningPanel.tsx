"use client";

// The four knobs the Swift client's settings had for a finger: pointer speed, acceleration,
// scroll speed, and natural scrolling. They tune the picture's Pointer mode as well as the deck,
// because both drive the same translator. The fifth is the web's own, how tall the deck is.

import { useId } from "react";
import { DECK_SHARE_MAX, DECK_SHARE_MIN, useDeckHeight } from "@/features/desktop-viewer/trackpad/deckHeightPreference";
import {
  TUNING_MAX,
  TUNING_MIN,
  useGestureTuning,
  type GestureTuning,
} from "@/features/desktop-viewer/pointer-input/gestureTuning";

type Multiplier = "cursorSpeed" | "cursorAcceleration" | "scrollSpeed";

const SLIDERS: Array<{ key: Multiplier; label: string }> = [
  { key: "cursorSpeed", label: "Pointer speed" },
  { key: "cursorAcceleration", label: "Acceleration" },
  { key: "scrollSpeed", label: "Scroll speed" },
];

export function GestureTuningPanel({ onClose }: { onClose: () => void }) {
  const tuning = useGestureTuning();
  const deck = useDeckHeight();
  const naturalId = useId();
  const set = (change: Partial<GestureTuning>) => tuning.setTuning(change);
  return (
    <div
      role="dialog"
      aria-label="Trackpad settings"
      data-testid="gesture-tuning"
      className="flex flex-col gap-2 rounded-xl border border-white/15 bg-neutral-950/95 p-3 text-[11px] text-white shadow-lg"
    >
      {SLIDERS.map(({ key, label }) => (
        <TuningSlider
          key={key}
          label={label}
          value={tuning[key]}
          min={TUNING_MIN}
          max={TUNING_MAX}
          step={0.1}
          format={(value) => `${value.toFixed(1)}×`}
          onChange={(value) => set({ [key]: value })}
        />
      ))}
      <TuningSlider
        label="Trackpad height"
        value={deck.deckShare}
        min={DECK_SHARE_MIN}
        max={DECK_SHARE_MAX}
        step={0.02}
        format={(value) => `${Math.round(value * 100)}%`}
        onChange={deck.setDeckShare}
      />
      <label htmlFor={naturalId} className="flex items-center gap-2">
        <input
          id={naturalId}
          type="checkbox"
          checked={tuning.naturalScrolling}
          onChange={(event) => set({ naturalScrolling: event.target.checked })}
          className="size-4 accent-blue-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
        />
        Natural scrolling
      </label>
      <div className="flex justify-between gap-2 pt-1">
        <button
          type="button"
          onClick={() => {
            tuning.resetTuning();
            deck.resetDeckShare();
          }}
          className="rounded-md px-2.5 py-1.5 text-white/75 transition-colors hover:bg-white/10 active:bg-white/15
            focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-white motion-reduce:transition-none"
        >
          Reset
        </button>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md bg-white px-2.5 py-1.5 text-black transition-colors hover:bg-white/90 active:bg-white/80
            focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white motion-reduce:transition-none"
        >
          Done
        </button>
      </div>
    </div>
  );
}

function TuningSlider({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (value: number) => string;
  onChange: (value: number) => void;
}) {
  const id = useId();
  return (
    <div className="flex items-center gap-2">
      <label htmlFor={id} className="w-24 shrink-0 text-white/75">
        {label}
      </label>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number.parseFloat(event.target.value))}
        className="h-1 min-w-0 flex-1 cursor-pointer appearance-none rounded-full bg-white/25 outline-none
          focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white
          [&::-webkit-slider-thumb]:size-4 [&::-webkit-slider-thumb]:appearance-none
          [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white
          [&::-moz-range-thumb]:size-4 [&::-moz-range-thumb]:rounded-full
          [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-white"
      />
      <span className="w-9 text-right tabular-nums text-white/75">{format(value)}</span>
    </div>
  );
}
