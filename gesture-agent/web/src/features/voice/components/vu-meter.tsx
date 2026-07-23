/**
 * Dumb VU bar. Given an RMS/peak amplitude pair (0..1), it renders a
 * dBFS-scaled fill and a floating peak marker. No store access, no logic beyond
 * the amplitude-to-width mapping.
 */

"use client";

import { cn } from "@/lib/utils";

interface VuMeterProps {
  readonly rms: number;
  readonly peak: number;
  readonly className?: string;
}

const FLOOR_DB = 60;

function toLevel(amplitude: number): number {
  if (amplitude <= 0) {
    return 0;
  }
  const db = 20 * Math.log10(amplitude);
  const level = (db + FLOOR_DB) / FLOOR_DB;
  return Math.min(1, Math.max(0, level));
}

export function VuMeter({ rms, peak, className }: VuMeterProps) {
  const rmsLevel = toLevel(rms);
  const peakLevel = toLevel(peak);
  const hot = peakLevel > 0.92;

  return (
    <div
      className={cn(
        "relative h-2.5 w-full overflow-hidden rounded-full bg-muted",
        className,
      )}
      role="meter"
      aria-label="Input level"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(rmsLevel * 100)}
    >
      <div
        className={cn(
          "h-full rounded-full transition-[width] duration-75 ease-out",
          hot ? "bg-destructive" : "bg-primary",
        )}
        style={{ width: `${rmsLevel * 100}%` }}
      />
      {peakLevel > 0 ? (
        <div
          className="absolute inset-y-0 w-0.5 bg-foreground/70"
          style={{ left: `calc(${peakLevel * 100}% - 1px)` }}
        />
      ) : null}
    </div>
  );
}
