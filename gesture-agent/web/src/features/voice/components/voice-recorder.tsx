/**
 * The record surface. It is a dumb view over the voice store and the session
 * controller: it renders the current run-state, the live meter, the streaming
 * transcript, and the preamp control, and it forwards intents (record / stop /
 * reset / preamp) to the hook. No capture, socket, or transition logic here.
 */

"use client";

import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  Mic,
  RotateCcw,
  Square,
} from "lucide-react";

import { LiveTranscript } from "@/features/voice/components/live-transcript";
import { MicrophoneSelector } from "@/features/voice/components/microphone-selector";
import { stopReferenceSpeech } from "@/features/voice/reference-speech";
import { VuMeter } from "@/features/voice/components/vu-meter";
import { useVoiceSession } from "@/features/voice/use-voice-session";
import {
  PREAMP_MAX,
  PREAMP_MIN,
  useVoiceStore,
} from "@/stores/voice-store";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import type { PracticePassage, Recording } from "@/lib/wire";

function firstValue(value: number | readonly number[]): number {
  return Array.isArray(value) ? value[0] : (value as number);
}

export function VoiceRecorder({
  passage,
  onNewPassage,
  onComplete,
}: {
  readonly passage?: PracticePassage;
  readonly onNewPassage: () => void;
  readonly onComplete: (recording: Recording) => void;
}) {
  const { startRecording, stopRecording, reset } = useVoiceSession({
    passage: passage ? { id: passage.id, revision: passage.revision } : undefined,
    onComplete,
  });

  const runState = useVoiceStore((state) => state.runState);
  const meter = useVoiceStore((state) => state.meter);
  const partial = useVoiceStore((state) => state.partialTranscript);
  const final = useVoiceStore((state) => state.finalTranscript);
  const preampGain = useVoiceStore((state) => state.preampGain);
  const setPreampGain = useVoiceStore((state) => state.setPreampGain);

  const status = runState.status;
  const isCapturing = status === "capturing";
  const isBusy =
    status === "requestingMic" ||
    status === "capturing" ||
    status === "saving" ||
    status === "transcribing" ||
    status === "analyzing";

  function resetRecorder(): void {
    stopReferenceSpeech();
    reset();
    onNewPassage();
  }

  return (
    <div className="flex flex-col gap-6">
      {passage ? (
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {passage.attemptCount === 0
              ? "Practice reference"
              : "Retake intended text"}
          </span>
          <p className="min-w-0 flex-1 basis-72 text-base leading-relaxed">
            {passage.intendedText}
          </p>
        </div>
      ) : null}
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-wrap items-center gap-3">
          {isCapturing ? (
            <Button variant="destructive" size="lg" onClick={stopRecording}>
              <Square />
              Stop
            </Button>
          ) : (
            <Button
              variant="default"
              size="lg"
              disabled={isBusy}
              onClick={() => {
                stopReferenceSpeech();
                void startRecording();
              }}
            >
              <Mic />
              {status === "complete" || status === "error"
                ? "Record again"
                : passage?.attemptCount === 0
                  ? "Record first attempt"
                  : "Record"}
            </Button>
          )}

          <Button
            variant="ghost"
            size="lg"
            disabled={isBusy && status !== "requestingMic"}
            onClick={resetRecorder}
          >
            <RotateCcw />
            Reset
          </Button>
          <StatusBadge status={status} />
        </div>
        <MicrophoneSelector disabled={isBusy} />
      </div>

      {runState.status === "error" ? (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>{runState.message}</span>
        </div>
      ) : null}

      <div className="flex flex-col gap-2">
        <span className="text-xs font-medium text-muted-foreground">
          Input level
        </span>
        <VuMeter rms={meter.rms} peak={meter.peak} />
      </div>

      <LiveTranscript
        partial={partial}
        final={final}
        placeholder={
          isCapturing
            ? "Listening..."
            : "Live transcript appears here while you record."
        }
      />

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-muted-foreground">
            Preamp gain
          </span>
          <span className="text-xs tabular-nums text-muted-foreground">
            {preampGain.toFixed(1)}x
          </span>
        </div>
        <Slider
          min={PREAMP_MIN}
          max={PREAMP_MAX}
          step={0.5}
          value={[preampGain]}
          disabled={isBusy}
          onValueChange={(value) => setPreampGain(firstValue(value))}
        />
        <span className="text-xs text-muted-foreground">
          Applied server-side to the transcription pass. Set before recording.
        </span>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { readonly status: string }) {
  switch (status) {
    case "requestingMic":
      return (
        <Badge variant="secondary">
          <Loader2 className="animate-spin" />
          Requesting mic
        </Badge>
      );
    case "capturing":
      return (
        <Badge variant="destructive">
          <span className="size-2 animate-pulse rounded-full bg-destructive" />
          Recording
        </Badge>
      );
    case "saving":
    case "transcribing":
    case "analyzing":
      return (
        <Badge variant="secondary">
          <Loader2 className="animate-spin" />
          {status[0].toUpperCase() + status.slice(1)}
        </Badge>
      );
    case "complete":
      return (
        <Badge variant="outline">
          <CheckCircle2 />
          Saved
        </Badge>
      );
    case "error":
      return (
        <Badge variant="destructive">
          <AlertCircle />
          Error
        </Badge>
      );
    default:
      return null;
  }
}
