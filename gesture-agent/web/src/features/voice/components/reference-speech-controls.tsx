"use client";

import { AlertCircle, CloudDownload, Loader2, Volume2 } from "lucide-react";
import { useEffect, useState } from "react";

import type {
  ReferenceSpeechSettingsView,
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

function firstValue(value: number | readonly number[]): number {
  return Array.isArray(value) ? value[0] : (value as number);
}

export function ReferenceSpeechControls({
  disabled,
  view,
  update,
}: {
  readonly disabled: boolean;
  readonly view: ReferenceSpeechSettingsView;
  readonly update: (voiceIdentifier: string, speed: number) => void;
}) {
  if (view.status === "loading") {
    return (
      <section
        aria-label="Reference speech"
        className="flex items-center gap-2 rounded-lg border border-border bg-background/70 p-3 text-sm text-muted-foreground"
      >
        <Loader2 className="size-4 animate-spin" />
        Loading Kokoro voices from the Mac
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
      key={`${view.preferences.voiceIdentifier}:${view.preferences.speed}`}
      disabled={disabled}
      view={view}
      update={update}
    />
  );
}

function ReadyReferenceSpeechControls({
  disabled,
  view,
  update,
}: {
  readonly disabled: boolean;
  readonly view: Extract<ReferenceSpeechSettingsView, { status: "ready" }>;
  readonly update: (voiceIdentifier: string, speed: number) => void;
}) {
  const { state, preferences } = view;
  const [draftSpeed, setDraftSpeed] = useState(preferences.speed);
  useEffect(() => setDraftSpeed(preferences.speed), [preferences.speed]);
  const controlsDisabled = disabled;
  const speedRange = state.speed.maximum - state.speed.minimum;
  const defaultPosition =
    speedRange === 0
      ? 50
      : ((state.speed.defaultValue - state.speed.minimum) / speedRange) * 100;

  function persist(voiceIdentifier: string, speed: number): void {
    stopReferenceSpeech();
    update(voiceIdentifier, speed);
  }

  return (
    <section
      aria-label="Reference speech"
      className="flex flex-col gap-3 rounded-lg border border-border bg-background/70 p-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <Volume2 className="size-4" />
          Reference speech
        </div>
        <span className="text-xs text-muted-foreground">
          Kokoro · generated and cached on Mac
        </span>
      </div>
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(9rem,0.8fr)]">
        <label className="flex min-w-0 flex-col gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">
            Kokoro voice
          </span>
          <Select
            disabled={controlsDisabled}
            value={preferences.voiceIdentifier}
            onValueChange={(value) => {
              if (typeof value === "string") {
                persist(value, preferences.speed);
              }
            }}
          >
            <SelectTrigger className="w-full" aria-label="Kokoro reference voice">
              <SelectValue placeholder="Choose a voice" />
            </SelectTrigger>
            <SelectContent>
              {state.voices.map((voice) => (
                <SelectItem key={voice.identifier} value={voice.identifier}>
                  {voice.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="flex items-center justify-between gap-2">
            <label
              className="text-xs font-medium text-muted-foreground"
              htmlFor="reference-speech-speed"
            >
              Reference speed
            </label>
            <span className="text-xs tabular-nums text-muted-foreground">
              {draftSpeed.toFixed(2)}×
            </span>
          </div>
          <div className="relative">
            <Slider
              aria-label="Kokoro reference speed"
              disabled={controlsDisabled}
              id="reference-speech-speed"
              min={state.speed.minimum}
              max={state.speed.maximum}
              step={0.05}
              value={[draftSpeed]}
              onValueChange={(value) => setDraftSpeed(firstValue(value))}
              onValueCommitted={(value) =>
                persist(preferences.voiceIdentifier, firstValue(value))
              }
            />
            <span
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 h-2.5 w-px -translate-x-1/2 -translate-y-1/2 bg-foreground/45"
              style={{ left: `${defaultPosition}%` }}
            />
          </div>
          <div className="flex justify-between text-[11px] text-muted-foreground">
            <span>{state.speed.minimum.toFixed(2)}×</span>
            <span>Default {state.speed.defaultValue.toFixed(2)}×</span>
            <span>{state.speed.maximum.toFixed(2)}×</span>
          </div>
        </div>
      </div>
      {state.status === "unavailable" || state.status === "preparing" ? (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {state.status === "preparing" ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <CloudDownload className="size-3" />
          )}
          {state.status === "preparing"
            ? "The Mac is preparing the Kokoro model."
            : "The pinned Kokoro model downloads on first playback."}
        </p>
      ) : null}
      {state.status === "failed" && state.error ? (
        <p className="text-xs text-destructive">{state.error}</p>
      ) : null}
      <p className="text-[11px] text-muted-foreground">
        {state.modelIdentifier} · {state.runtimeIdentifier}
      </p>
    </section>
  );
}
