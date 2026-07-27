"use client";

import { AlertCircle, Loader2, Volume2 } from "lucide-react";
import { useState } from "react";

import {
  type ReferenceSpeechState,
  useReferenceSpeechSettings,
} from "@/features/voice/reference-speech-settings";
import { stopReferenceSpeech } from "@/features/voice/reference-speech";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";

const SYSTEM_DEFAULT_VALUE = "__system_default__";

function firstValue(value: number | readonly number[]): number {
  return Array.isArray(value) ? value[0] : (value as number);
}

export function ReferenceSpeechControls({
  disabled,
}: {
  readonly disabled: boolean;
}) {
  const { view, update } = useReferenceSpeechSettings();

  if (view.status === "loading") {
    return (
      <section
        aria-label="Reference speech"
        className="flex items-center gap-2 rounded-lg border border-border bg-background/70 p-3 text-sm text-muted-foreground"
      >
        <Loader2 className="size-4 animate-spin" />
        Loading native voices
      </section>
    );
  }

  if (view.status === "error") {
    return (
      <section
        aria-label="Reference speech"
        className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
      >
        <AlertCircle className="mt-0.5 size-4 shrink-0" />
        {view.message}
      </section>
    );
  }

  return (
    <ReadyReferenceSpeechControls
      key={`${view.state.selectedVoiceIdentifier ?? "system"}:${view.state.rate.current}`}
      disabled={disabled}
      state={view.state}
      update={update}
      updating={view.updating}
    />
  );
}

function ReadyReferenceSpeechControls({
  disabled,
  state,
  update,
  updating,
}: {
  readonly disabled: boolean;
  readonly state: ReferenceSpeechState;
  readonly update: (voiceIdentifier: string | null, rate: number) => void;
  readonly updating: boolean;
}) {
  const [draftRate, setDraftRate] = useState(state.rate.current);

  const controlsDisabled = disabled || updating;
  const selectedValue =
    state.selectedVoiceIdentifier ?? SYSTEM_DEFAULT_VALUE;
  const rateRange = state.rate.maximum - state.rate.minimum;
  const defaultRatePosition =
    rateRange === 0
      ? 50
      : ((state.rate.defaultValue - state.rate.minimum) / rateRange) * 100;

  function persist(
    voiceIdentifier: string | null,
    rate: number,
  ): void {
    stopReferenceSpeech();
    update(voiceIdentifier, rate);
  }

  return (
    <section
      aria-label="Reference speech"
      className="flex flex-col gap-3 rounded-lg border border-border bg-background/70 p-3"
    >
      <div className="flex items-center gap-2 text-sm font-semibold">
        <Volume2 className="size-4" />
        Reference speech
      </div>
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(9rem,0.8fr)]">
        <label className="flex min-w-0 flex-col gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">
            Voice
          </span>
          <Select
            disabled={controlsDisabled}
            value={selectedValue}
            onValueChange={(value) => {
              if (typeof value !== "string") return;
              persist(
                value === SYSTEM_DEFAULT_VALUE ? null : value,
                state.rate.current,
              );
            }}
          >
            <SelectTrigger className="w-full" aria-label="Reference voice">
              <SelectValue placeholder="Choose a voice" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={SYSTEM_DEFAULT_VALUE}>
                System Default (en-US)
              </SelectItem>
              {state.voices.map((voice) => (
                <SelectItem key={voice.identifier} value={voice.identifier}>
                  {voice.name}
                  {voice.quality === "premium"
                    ? " (Premium)"
                    : voice.quality === "enhanced"
                      ? " (Enhanced)"
                      : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="flex items-center justify-between gap-2">
            <label
              className="text-xs font-medium text-muted-foreground"
              htmlFor="reference-speech-rate"
            >
              Native rate
            </label>
            <span className="text-xs tabular-nums text-muted-foreground">
              {draftRate.toFixed(2)}
            </span>
          </div>
          <div className="relative">
            <Slider
              aria-label="Native speech rate"
              disabled={controlsDisabled}
              id="reference-speech-rate"
              min={state.rate.minimum}
              max={state.rate.maximum}
              step={0.05}
              value={[draftRate]}
              onValueChange={(value) => setDraftRate(firstValue(value))}
              onValueCommitted={(value) =>
                persist(
                  state.selectedVoiceIdentifier ?? null,
                  firstValue(value),
                )
              }
            />
            <span
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 h-2.5 w-px -translate-x-1/2 -translate-y-1/2 bg-foreground/45"
              style={{ left: `${defaultRatePosition}%` }}
            />
          </div>
          <div className="flex justify-between text-[11px] text-muted-foreground">
            <span>{state.rate.minimum.toFixed(2)}</span>
            <span>Default {state.rate.defaultValue.toFixed(2)}</span>
            <span>{state.rate.maximum.toFixed(2)}</span>
          </div>
        </div>
      </div>
      {state.notice ? (
        <p className="text-xs text-muted-foreground">{state.notice}</p>
      ) : null}
      {state.error ? (
        <p className="text-xs text-destructive">{state.error}</p>
      ) : null}
    </section>
  );
}
