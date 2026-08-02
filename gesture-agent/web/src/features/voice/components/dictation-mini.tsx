/**
 * The all-Spaces macOS dictation surface. It deliberately shares the normal
 * voice session hook, so browser microphone frames enter the exact same
 * sidecar recording/finalization path as the full Voice panel.
 */

"use client";

import { AlertCircle, Loader2, Square } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { VuMeter } from "@/features/voice/components/vu-meter";
import {
  DICTATION_TERMINAL_DISMISS_MS,
  dictationErrorMessage,
  isDictationMiniExpanded,
  isDictationRunActive,
  shouldCommitDictation,
} from "@/features/voice/dictation-mini-state";
import { useVoiceSession } from "@/features/voice/use-voice-session";
import { postToHost } from "@/lib/host-bridge";
import { subscribeInteractionDelivery } from "@/lib/interaction-delivery";
import { useVoiceStore, type VoiceRunStatus } from "@/stores/voice-store";

type DictationCapture = { readonly command: "start" | "stop" };

function DictationMicArtwork() {
  return (
    <picture aria-hidden="true">
      <source media="(prefers-color-scheme: dark)" srcSet="./dictation-mic-dark.png" />
      <img className="size-8 object-contain" src="./dictation-mic.png" alt="" />
    </picture>
  );
}

function stageLabel(status: VoiceRunStatus): string {
  switch (status) {
    case "requestingMic":
      return "Requesting microphone…";
    case "capturing":
      return "Listening…";
    case "saving":
      return "Saving recording…";
    case "transcribing":
      return "Transcribing…";
    case "analyzing":
      return "Analyzing pronunciation…";
    default:
      return "";
  }
}

export function DictationMini() {
  const [completedTranscript, setCompletedTranscript] = useState("");
  const [nativeStart, setNativeStart] = useState(false);
  const committedRecordingIDs = useRef(new Set<string>());
  const dismissTimer = useRef<number | null>(null);
  const runState = useVoiceStore((state) => state.runState);
  const meter = useVoiceStore((state) => state.meter);
  const partial = useVoiceStore((state) => state.partialTranscript);
  const final = useVoiceStore((state) => state.finalTranscript);

  const clearDismissTimer = useCallback(() => {
    if (dismissTimer.current !== null) {
      window.clearTimeout(dismissTimer.current);
      dismissTimer.current = null;
    }
  }, []);

  const { startRecording, stopRecording, reset } = useVoiceSession({
    onComplete: (recording) => {
      const transcript = recording.transcript?.trim() ?? "";
      setCompletedTranscript(transcript);
      if (
        shouldCommitDictation(
          committedRecordingIDs.current,
          recording.id,
          transcript,
        )
      ) {
        committedRecordingIDs.current.add(recording.id);
        postToHost("interaction", {
          t: "dictationCommit",
          recordingID: recording.id,
          transcript,
        });
      }
    },
  });

  const begin = useCallback(
    (fromNative: boolean) => {
      clearDismissTimer();
      setCompletedTranscript("");
      setNativeStart(fromNative);
      void startRecording();
    },
    [clearDismissTimer, startRecording],
  );

  const end = useCallback(() => {
    stopRecording();
  }, [stopRecording]);

  useEffect(() => {
    const unsubscribe = subscribeInteractionDelivery<DictationCapture>(
      "dictationCapture",
      ({ command }) => {
        if (command === "start") begin(true);
        else end();
      },
    );
    postToHost("interaction", { t: "dictationReady" });
    return unsubscribe;
  }, [begin, end]);

  useEffect(() => {
    const stopForFocusLoss = () => {
      if (isDictationRunActive(useVoiceStore.getState().runState.status)) end();
    };
    const stopForVisibilityLoss = () => {
      if (document.visibilityState !== "visible") stopForFocusLoss();
    };
    window.addEventListener("blur", stopForFocusLoss);
    document.addEventListener("visibilitychange", stopForVisibilityLoss);
    return () => {
      window.removeEventListener("blur", stopForFocusLoss);
      document.removeEventListener("visibilitychange", stopForVisibilityLoss);
    };
  }, [end]);

  const status = runState.status;
  const expanded = isDictationMiniExpanded(status);
  useEffect(() => {
    postToHost("interaction", { t: "dictationLayout", expanded });
  }, [expanded]);
  useEffect(() => {
    postToHost("interaction", { t: "dictationRunState", status });
  }, [status]);

  useEffect(() => {
    if (status !== "complete" && status !== "error") return;
    clearDismissTimer();
    dismissTimer.current = window.setTimeout(() => {
      reset();
      setCompletedTranscript("");
      setNativeStart(false);
      dismissTimer.current = null;
    }, DICTATION_TERMINAL_DISMISS_MS);
    return clearDismissTimer;
  }, [clearDismissTimer, reset, status]);

  useEffect(
    () => () => clearDismissTimer(),
    [clearDismissTimer],
  );

  const errorMessage =
    status === "error" ? dictationErrorMessage(nativeStart, runState.message) : null;
  const transcript = completedTranscript || final || partial;
  const blocksNewPress =
    status === "saving" || status === "transcribing" || status === "analyzing";

  return (
    <main className="flex h-full w-full items-center justify-center overflow-hidden rounded-[22px] border border-black/15 bg-[#e3e8ee] p-2 shadow-[inset_0_1px_0_rgb(255_255_255_/_0.7)] dark:border-white/15 dark:bg-[#24282d] dark:shadow-[inset_0_1px_0_rgb(255_255_255_/_0.08)]">
      <button
        type="button"
        aria-label={status === "capturing" ? "Stop dictation" : "Start dictation"}
        className={`flex h-12 shrink-0 items-center rounded-2xl border border-black/10 bg-white text-foreground shadow-[0_2px_5px_rgb(0_0_0_/_0.14)] transition hover:bg-white/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-70 dark:border-white/10 dark:bg-[#17191c] dark:hover:bg-[#202328] ${expanded ? "min-w-12 gap-3 px-3" : "w-12 justify-center p-0"}`}
        // Requesting permission stays enabled so the pointer that started a
        // press-and-hold can still deliver its release and cancel the pending
        // capture. Only server finalization blocks a new press.
        disabled={blocksNewPress}
        onPointerDown={(event) => {
          if (status === "capturing") return;
          event.currentTarget.setPointerCapture(event.pointerId);
          begin(false);
        }}
        onPointerUp={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
          end();
        }}
        onPointerCancel={end}
      >
        {status === "capturing" ? (
          <Square className="size-5 fill-current text-destructive" />
        ) : status === "requestingMic" ||
          status === "saving" ||
          status === "transcribing" ||
          status === "analyzing" ? (
          <Loader2 className="size-5 animate-spin text-primary" />
        ) : status === "error" ? (
          <AlertCircle className="size-5 text-destructive" />
        ) : (
          <DictationMicArtwork />
        )}
        {expanded ? (
          <span className="min-w-0 text-left text-sm font-medium">
            {errorMessage ??
              (status === "complete"
                ? transcript || "Saved without a transcript"
                : stageLabel(status))}
          </span>
        ) : null}
      </button>
      {status === "capturing" ? (
        <div className="ml-2 w-44">
          <VuMeter rms={meter.rms} peak={meter.peak} />
          {transcript ? (
            <p className="mt-1 truncate text-xs text-muted-foreground">{transcript}</p>
          ) : null}
        </div>
      ) : null}
    </main>
  );
}
