"use client";

/**
 * Pronunciation comparison surface: choose a reference take and a learner take,
 * run the DTW comparison, then show the alignment cost, an overall closeness
 * read-out, and the most-divergent alignment steps. Selection state is local
 * momentum; the comparison result is owned by the mutation hook.
 */

import { AlertCircle, ArrowRight, Loader2 } from "lucide-react";
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type {
  PronunciationComparison,
  PronunciationFrameCostPayload,
  Recording,
} from "@/lib/wire";

import { formatFixed, formatRatio } from "../format";
import { usePronunciationComparison } from "../hooks";
import { RecordingSelect } from "./recording-select";

const DIVERGENT_STEP_COUNT = 8;

export interface PronunciationViewProps {
  recordings: Recording[];
}

export function PronunciationView({ recordings }: PronunciationViewProps) {
  const [referenceId, setReferenceId] = useState<string | null>(null);
  const [learnerId, setLearnerId] = useState<string | null>(null);
  const comparison = usePronunciationComparison();

  const canRun =
    referenceId !== null && learnerId !== null && !comparison.isPending;

  function run() {
    if (referenceId === null || learnerId === null) return;
    comparison.mutate({
      referenceRecordingId: referenceId,
      learnerRecordingId: learnerId,
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium">Reference</label>
          <RecordingSelect
            recordings={recordings}
            value={referenceId}
            onChange={setReferenceId}
            excludeId={learnerId}
            placeholder="Reference take"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium">Learner</label>
          <RecordingSelect
            recordings={recordings}
            value={learnerId}
            onChange={setLearnerId}
            excludeId={referenceId}
            placeholder="Learner take"
          />
        </div>
      </div>

      <div>
        <Button onClick={run} disabled={!canRun}>
          {comparison.isPending ? (
            <>
              <Loader2 className="size-4 animate-spin" />
              Comparing…
            </>
          ) : (
            "Compare pronunciation"
          )}
        </Button>
      </div>

      {comparison.isError ? (
        <div
          role="alert"
          className="flex items-center gap-2 rounded-lg border border-dashed border-destructive/40 px-3 py-4 text-sm text-destructive"
        >
          <AlertCircle className="size-4" />
          <span>{comparison.error.message}</span>
        </div>
      ) : comparison.data ? (
        <ComparisonReport result={comparison.data} />
      ) : (
        <div className="flex h-24 items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
          Pick two recordings and run the comparison.
        </div>
      )}
    </div>
  );
}

function ComparisonReport({ result }: { result: PronunciationComparison }) {
  const divergent = useMemo(() => {
    return [...result.trace]
      .sort((a, b) => b.cost - a.cost)
      .slice(0, DIVERGENT_STEP_COUNT);
  }, [result.trace]);

  const maxCost = divergent[0]?.cost ?? 0;

  return (
    <div className="flex flex-col gap-4">
      <Card size="sm">
        <CardHeader>
          <CardTitle>Alignment closeness</CardTitle>
          <CardDescription>
            Dynamic time-warping match across {result.coefficientCount} MFCC
            coefficients. Higher closeness means the takes track each other more
            tightly.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <ClosenessMeter closeness={result.closeness} />
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <StatTile label="Closeness" value={formatRatio(result.closeness)} />
            <StatTile label="DTW distance" value={formatFixed(result.distance, 2)} />
            <StatTile label="Path length" value={String(result.pathLength)} />
            <StatTile
              label="Frames (ref / learner)"
              value={`${result.referenceFrameCount} / ${result.learnerFrameCount}`}
            />
          </div>
        </CardContent>
      </Card>

      <Card size="sm">
        <CardHeader>
          <CardTitle>Most-divergent steps</CardTitle>
          <CardDescription>
            Alignment points where the takes cost the most to match, worst first.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {divergent.length === 0 ? (
            <p className="text-sm text-muted-foreground">No alignment steps.</p>
          ) : (
            <ol className="flex flex-col gap-2">
              {divergent.map((step, index) => (
                <DivergentStep
                  key={`${step.referenceSeconds}-${step.learnerSeconds}-${index}`}
                  step={step}
                  maxCost={maxCost}
                />
              ))}
            </ol>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function ClosenessMeter({ closeness }: { closeness: number }) {
  const pct = Math.max(0, Math.min(1, closeness)) * 100;
  return (
    <div
      className="h-2 w-full overflow-hidden rounded-full bg-muted"
      role="meter"
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label="Pronunciation closeness"
    >
      <div
        className="h-full rounded-full bg-primary transition-[width]"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

function DivergentStep({
  step,
  maxCost,
}: {
  step: PronunciationFrameCostPayload;
  maxCost: number;
}) {
  const width = maxCost > 0 ? (step.cost / maxCost) * 100 : 0;
  return (
    <li className="flex flex-col gap-1 rounded-lg border bg-card px-3 py-2">
      <div className="flex items-center justify-between text-sm">
        <span className="flex items-center gap-1.5 font-mono tabular-nums">
          {step.referenceSeconds.toFixed(2)}s
          <ArrowRight className="size-3.5 text-muted-foreground" />
          {step.learnerSeconds.toFixed(2)}s
        </span>
        <span className="font-mono text-sm tabular-nums text-muted-foreground">
          {formatFixed(step.cost, 2)}
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-destructive/70"
          style={{ width: `${width}%` }}
        />
      </div>
    </li>
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
