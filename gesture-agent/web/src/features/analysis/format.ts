/**
 * Presentation-only formatting helpers for the analysis feature. No data
 * fetching, no React. Pure functions so views stay dumb.
 */

import type { Recording } from "@/lib/wire";

/** Short, human-scannable label for a recording in a picker. */
export function recordingLabel(recording: Recording): string {
  const transcript = recording.transcript?.trim();
  const head = transcript
    ? truncate(transcript, 42)
    : `Recording ${recording.id.slice(0, 8)}`;
  return `${head} · ${formatSeconds(recording.durationSeconds)}`;
}

/** Secondary caption line for a recording (timestamp + sample rate). */
export function recordingCaption(recording: Recording): string {
  return `${formatTimestamp(recording.createdAt)} · ${formatHz(recording.sampleRate)}`;
}

export function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1).trimEnd()}…`;
}

export function formatSeconds(seconds: number): string {
  if (!Number.isFinite(seconds)) return "—";
  if (seconds < 1) return `${Math.round(seconds * 1000)} ms`;
  return `${seconds.toFixed(seconds < 10 ? 2 : 1)} s`;
}

export function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatHz(hz: number): string {
  if (!Number.isFinite(hz)) return "—";
  if (hz >= 1000) return `${(hz / 1000).toFixed(hz >= 10_000 ? 0 : 1)} kHz`;
  return `${Math.round(hz)} Hz`;
}

export function formatDecibels(db: number): string {
  if (!Number.isFinite(db)) return "—";
  return `${db.toFixed(1)} dB`;
}

export function formatRatio(ratio: number): string {
  if (!Number.isFinite(ratio)) return "—";
  return `${(ratio * 100).toFixed(0)}%`;
}

export function formatFixed(value: number, digits = 3): string {
  if (!Number.isFinite(value)) return "—";
  return value.toFixed(digits);
}
