"use client";

/**
 * Signal analysis surface: pick a saved recording, then render its RMS,
 * spectral-centroid and rolloff curves over time plus a summary stat row.
 * All fetching lives in hooks; this component only shapes payloads into charts.
 */

import { AlertCircle, Loader2 } from "lucide-react";
import type { ReactNode } from "react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { SignalAnalysis, VoiceSignalFramePayload } from "@/lib/wire";

import {
  formatDecibels,
  formatFixed,
  formatHz,
  formatRatio,
  formatSeconds,
} from "../format";
import { useSignalAnalysis } from "../hooks";
import { LineChart, type ChartPoint } from "./line-chart";
import { RecordingSelect } from "./recording-select";
import type { Recording } from "@/lib/wire";

/**
 * Fixed, mid-lightness hues chosen to stay legible on both light and dark
 * surfaces and to be distinguishable for common color-vision deficiencies
 * (blue / amber / teal separate well on hue and on lightness).
 */
const METRIC_COLORS = {
  rms: "oklch(0.62 0.19 255)",
  centroid: "oklch(0.72 0.17 65)",
  rolloff: "oklch(0.68 0.14 165)",
} as const;

const formatTime = (value: number) => `${value.toFixed(1)}s`;

function series(
  frames: VoiceSignalFramePayload[],
  pick: (frame: VoiceSignalFramePayload) => number,
): ChartPoint[] {
  return frames.map((frame) => ({ x: frame.elapsedSeconds, y: pick(frame) }));
}

export interface SignalAnalysisViewProps {
  recordings: Recording[];
  recordingId: string | null;
  onSelect: (recordingId: string) => void;
}

export function SignalAnalysisView({
  recordings,
  recordingId,
  onSelect,
}: SignalAnalysisViewProps) {
  const query = useSignalAnalysis(recordingId);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <label className="text-sm font-medium">Recording</label>
        <RecordingSelect
          recordings={recordings}
          value={recordingId}
          onChange={onSelect}
          placeholder="Select a recording to analyze"
        />
      </div>

      {recordingId === null ? (
        <EmptyHint>Pick a recording to see its signal curves.</EmptyHint>
      ) : query.isPending ? (
        <StatusRow icon="spin">Analyzing signal…</StatusRow>
      ) : query.isError ? (
        <StatusRow icon="alert" tone="error">
          {query.error.message}
        </StatusRow>
      ) : (
        <SignalReport analysis={query.data} />
      )}
    </div>
  );
}

function SignalReport({ analysis }: { analysis: SignalAnalysis }) {
  const { summary, frames } = analysis;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <StatTile label="Duration" value={formatSeconds(summary.durationSeconds)} />
        <StatTile label="Mean level" value={formatDecibels(summary.meanDecibels)} />
        <StatTile label="Peak" value={formatFixed(summary.peakAmplitude, 3)} />
        <StatTile label="Silence" value={formatRatio(summary.silenceRatio)} />
        <StatTile
          label="Mean centroid"
          value={formatHz(summary.meanSpectralCentroidHz)}
        />
        <StatTile
          label="Zero-cross"
          value={formatFixed(summary.meanZeroCrossingRate, 3)}
        />
      </div>

      <MetricChart
        title="Loudness (RMS)"
        description="Root-mean-square energy per frame. Higher means louder."
        color={METRIC_COLORS.rms}
        points={series(frames, (frame) => frame.rms)}
        formatY={(value) => value.toFixed(3)}
      />
      <MetricChart
        title="Spectral centroid"
        description="Center of mass of the spectrum. Higher reads as brighter."
        color={METRIC_COLORS.centroid}
        points={series(frames, (frame) => frame.spectralCentroidHz)}
        formatY={formatHz}
      />
      <MetricChart
        title="Spectral rolloff"
        description="Frequency below which most energy sits. Tracks brightness/noise."
        color={METRIC_COLORS.rolloff}
        points={series(frames, (frame) => frame.spectralRolloffHz)}
        formatY={formatHz}
      />
    </div>
  );
}

interface MetricChartProps {
  title: string;
  description: string;
  color: string;
  points: ChartPoint[];
  formatY: (value: number) => string;
}

function MetricChart({
  title,
  description,
  color,
  points,
  formatY,
}: MetricChartProps) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <span
            aria-hidden
            className="size-2.5 rounded-full"
            style={{ backgroundColor: color }}
          />
          {title}
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        <LineChart
          points={points}
          color={color}
          yLabel={title}
          formatX={formatTime}
          formatY={formatY}
        />
      </CardContent>
    </Card>
  );
}

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-lg border bg-card px-3 py-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="font-mono text-sm font-medium tabular-nums">{value}</span>
    </div>
  );
}

function EmptyHint({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-32 items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
      {children}
    </div>
  );
}

function StatusRow({
  children,
  icon,
  tone = "muted",
}: {
  children: ReactNode;
  icon: "spin" | "alert";
  tone?: "muted" | "error";
}) {
  return (
    <div
      className={cnTone(tone)}
      role={tone === "error" ? "alert" : "status"}
    >
      {icon === "spin" ? (
        <Loader2 className="size-4 animate-spin" />
      ) : (
        <AlertCircle className="size-4" />
      )}
      <span>{children}</span>
    </div>
  );
}

function cnTone(tone: "muted" | "error"): string {
  const base =
    "flex h-32 items-center justify-center gap-2 rounded-lg border border-dashed text-sm";
  return tone === "error"
    ? `${base} border-destructive/40 text-destructive`
    : `${base} text-muted-foreground`;
}
