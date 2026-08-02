/**
 * The all-Spaces macOS dictation surface. It deliberately shares the normal
 * voice session hook, so browser microphone frames enter the exact same
 * sidecar recording/finalization path as the full Voice panel.
 */

"use client";

import { AlertCircle, Loader2, Send, Square } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { VuMeter } from "@/features/voice/components/vu-meter";
import {
  DICTATION_TERMINAL_DISMISS_MS,
  applyDictationPrefix,
  dictationClickAction,
  dictationErrorMessage,
  isDictationMiniExpanded,
  isDictationRunActive,
  shouldCommitDictation,
} from "@/features/voice/dictation-mini-state";
import { useVoiceSession } from "@/features/voice/use-voice-session";
import { getHostConfig, postToHost } from "@/lib/host-bridge";
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
  const clientDictation = getHostConfig()?.dictationMode === "client";
  const [completedTranscript, setCompletedTranscript] = useState("");
  const [completedRecordingID, setCompletedRecordingID] = useState<string | null>(null);
  const [editableTranscript, setEditableTranscript] = useState("");
  const [recordingPrefixEnabled, setRecordingPrefixEnabled] = useState(false);
  const [recordingPrefix, setRecordingPrefix] = useState("Dictated:");
  const [nativeStart, setNativeStart] = useState(false);
  const committedRecordingIDs = useRef(new Set<string>());
  const dismissTimer = useRef<number | null>(null);
  const hostMiniRef = useRef<HTMLElement | null>(null);
  const reportedHostLayout = useRef<string | null>(null);
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
      if (clientDictation) {
        setCompletedRecordingID(recording.id);
        setEditableTranscript(transcript);
        return;
      }
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
      setCompletedRecordingID(null);
      setEditableTranscript("");
      setNativeStart(fromNative);
      void startRecording();
    },
    [clearDismissTimer, startRecording],
  );

  const end = useCallback(() => {
    stopRecording();
  }, [stopRecording]);

  // Readiness is announced once per mount, and Fn always reaches the current
  // handlers. Naming a callback in this effect's dependencies instead couples
  // that announcement to how stable the voice session's identities happen to
  // be: when they last churned, the mini re-announced itself and re-subscribed
  // on every meter tick, eight times a second for a whole recording.
  const beginRef = useRef(begin);
  beginRef.current = begin;
  const endRef = useRef(end);
  endRef.current = end;

  useEffect(() => {
    const unsubscribe = subscribeInteractionDelivery<DictationCapture>(
      "dictationCapture",
      ({ command }) => {
        if (command === "start") beginRef.current(true);
        else endRef.current();
      },
    );
    postToHost("interaction", { t: "dictationReady" });
    return unsubscribe;
  }, []);

  // A hidden surface cannot be stopped by its own control, so it stops itself.
  // Losing focus is NOT that case: clicking record and then clicking back into
  // the app being dictated into is the normal path, and stopping on blur ended
  // every such run the moment it started.
  useEffect(() => {
    const stopForVisibilityLoss = () => {
      if (document.visibilityState === "visible") return;
      if (isDictationRunActive(useVoiceStore.getState().runState.status)) {
        endRef.current();
      }
    };
    document.addEventListener("visibilitychange", stopForVisibilityLoss);
    return () => {
      document.removeEventListener("visibilitychange", stopForVisibilityLoss);
    };
  }, []);

  const status = runState.status;
  const expanded = isDictationMiniExpanded(status);
  const reportHostLayout = useCallback(() => {
    if (clientDictation) return;
    const panel = hostMiniRef.current;
    if (!panel) return;

    const bounds = panel.getBoundingClientRect();
    const width = Math.ceil(bounds.width);
    const height = Math.ceil(bounds.height);
    if (width < 68 || height < 68) return;

    const nextLayout = `${width}x${height}`;
    if (reportedHostLayout.current === nextLayout) return;
    reportedHostLayout.current = nextLayout;
    postToHost("interaction", { t: "dictationLayout", width, height });
  }, [clientDictation]);

  useLayoutEffect(() => {
    if (clientDictation) return;
    const panel = hostMiniRef.current;
    if (!panel) return;

    const observer = new ResizeObserver(reportHostLayout);
    observer.observe(panel);
    const frame = window.requestAnimationFrame(reportHostLayout);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [clientDictation, reportHostLayout]);

  // The failure text rides along so the native shell's log can name the cause
  // instead of only recording that the run ended in error.
  const failureDetail = runState.status === "error" ? runState.message : null;
  useEffect(() => {
    postToHost("interaction", {
      t: "dictationRunState",
      status,
      ...(failureDetail ? { message: failureDetail } : {}),
    });
  }, [failureDetail, status]);

  useEffect(() => {
    if (clientDictation) return;
    if (status !== "complete" && status !== "error") return;
    clearDismissTimer();
    dismissTimer.current = window.setTimeout(() => {
      reset();
      setCompletedTranscript("");
      setNativeStart(false);
      dismissTimer.current = null;
    }, DICTATION_TERMINAL_DISMISS_MS);
    return clearDismissTimer;
  }, [clearDismissTimer, clientDictation, reset, status]);

  useEffect(
    () => () => clearDismissTimer(),
    [clearDismissTimer],
  );

  const errorMessage =
    status === "error" ? dictationErrorMessage(nativeStart, runState.message) : null;
  const transcript = completedTranscript || final || partial;
  const blocksNewPress =
    status === "saving" || status === "transcribing" || status === "analyzing";
  const hasValidRecordingPrefix =
    !recordingPrefixEnabled || recordingPrefix.trim().length > 0;

  const submit = useCallback(() => {
    const value = applyDictationPrefix(
      editableTranscript,
      recordingPrefixEnabled,
      recordingPrefix,
    );
    if (!completedRecordingID || !value) return;
    // The iPhone native sheet owns commit deduplication because it may reject
    // this exact recording for an unavailable host or an unsupported remote
    // keyboard character. Keeping the web button retryable lets an edited
    // transcript recover from that explicit error.
    postToHost("interaction", {
      t: "dictationCommit",
      recordingID: completedRecordingID,
      transcript: value,
    });
  }, [
    completedRecordingID,
    editableTranscript,
    recordingPrefix,
    recordingPrefixEnabled,
  ]);

  if (clientDictation) {
    const canEdit = status === "complete" && completedRecordingID !== null;
    const micLabel = status === "capturing" ? "Stop recording" : "Start recording";
    const helper = errorMessage
      ? errorMessage
      : status === "complete"
        ? "Review the transcript, then send it to the focused Mac field."
        : status === "capturing"
          ? "Listening. Tap Stop when you are done."
          : stageLabel(status) || "Tap the microphone to dictate.";

    return (
      <main className="h-full w-full overflow-y-auto bg-background p-4 text-foreground">
        <section className="mx-auto flex min-h-full w-full max-w-lg flex-col gap-4 rounded-3xl border border-border bg-card p-4 shadow-sm">
          <header>
            <h1 className="text-lg font-semibold">Dictate to Mac</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Audio is saved and transcribed by your paired Mac.
            </p>
          </header>

          <label className="flex min-h-40 flex-1 flex-col gap-2" htmlFor="dictation-transcript">
            <span className="text-sm font-medium">Transcript</span>
            <textarea
              id="dictation-transcript"
              aria-describedby="dictation-status"
              className="min-h-32 w-full flex-1 resize-y rounded-2xl border border-input bg-background p-3 text-base leading-6 outline-none ring-offset-background placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-70"
              disabled={!canEdit}
              onChange={(event) => setEditableTranscript(event.target.value)}
              placeholder={
                canEdit
                  ? "Review or edit the transcription"
                  : "Your transcript will appear here after recording."
              }
              value={canEdit ? editableTranscript : transcript}
            />
          </label>

          <section
            className="border-y border-border py-4"
            aria-labelledby="recording-prefix-title"
          >
            <div className="flex items-center justify-between gap-4">
              <div>
                <h2 id="recording-prefix-title" className="text-sm font-medium">
                  Recording prefix
                </h2>
                <p id="recording-prefix-help" className="mt-1 text-sm text-muted-foreground">
                  {recordingPrefixEnabled
                    ? "This text is added before the reviewed transcript when you send it."
                    : "Set the text now. It stays off until you turn on the switch."}
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={recordingPrefixEnabled}
                aria-describedby="recording-prefix-help"
                aria-label="Apply recording prefix"
                className={`relative h-11 w-12 shrink-0 rounded-full p-1 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${
                  recordingPrefixEnabled ? "bg-primary" : "bg-muted"
                }`}
                onClick={() => setRecordingPrefixEnabled((isEnabled) => !isEnabled)}
              >
                <span
                  aria-hidden="true"
                  className={`block size-9 rounded-full bg-background shadow-sm transition-transform ${
                    recordingPrefixEnabled ? "translate-x-1" : "translate-x-0"
                  }`}
                />
              </button>
            </div>

            <label className="mt-3 flex flex-col gap-2" htmlFor="recording-prefix">
              <span className="text-sm font-medium">Prefix text</span>
              <input
                id="recording-prefix"
                aria-describedby={
                  recordingPrefixEnabled && !recordingPrefix.trim()
                    ? "recording-prefix-help recording-prefix-error"
                    : "recording-prefix-help"
                }
                className="min-h-11 w-full rounded-xl border border-input bg-background px-3 text-base outline-none ring-offset-background placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
                onChange={(event) => setRecordingPrefix(event.target.value)}
                value={recordingPrefix}
              />
            </label>
            {recordingPrefixEnabled && !recordingPrefix.trim() ? (
              <p id="recording-prefix-error" className="mt-2 text-sm text-destructive" role="alert">
                Enter a prefix or turn this off before sending.
              </p>
            ) : null}
          </section>

          <p
            id="dictation-status"
            className={errorMessage ? "text-sm text-destructive" : "text-sm text-muted-foreground"}
            role={errorMessage ? "alert" : "status"}
          >
            {helper}
          </p>

          {status === "capturing" ? (
            <div className="rounded-2xl border border-border bg-muted/40 p-3">
              <VuMeter rms={meter.rms} peak={meter.peak} />
            </div>
          ) : null}

          <div className="grid grid-cols-2 gap-3">
            <button
              type="button"
              aria-label={micLabel}
              className="flex min-h-14 items-center justify-center gap-2 rounded-2xl border border-border bg-secondary px-4 text-base font-medium transition hover:bg-secondary/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-70"
              disabled={blocksNewPress}
              onClick={() => {
                const action = dictationClickAction(status);
                if (action === "start") begin(false);
                else if (action === "stop") end();
              }}
            >
              {status === "capturing" ? (
                <Square className="size-5 fill-current text-destructive" />
              ) : status === "requestingMic" || blocksNewPress ? (
                <Loader2 className="size-5 animate-spin text-primary" />
              ) : status === "error" ? (
                <AlertCircle className="size-5 text-destructive" />
              ) : (
                <DictationMicArtwork />
              )}
              <span>{status === "capturing" ? "Stop" : "Record"}</span>
            </button>
            <button
              type="button"
              className="flex min-h-14 items-center justify-center gap-2 rounded-2xl bg-primary px-4 text-base font-medium text-primary-foreground transition hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
              disabled={
                !canEdit || !editableTranscript.trim() || !hasValidRecordingPrefix
              }
              onClick={submit}
            >
              <Send className="size-5" aria-hidden="true" />
              <span>Send to Mac</span>
            </button>
          </div>
        </section>
      </main>
    );
  }

  const hostStage =
    errorMessage ??
    (status === "complete"
      ? transcript || "Saved without a transcript"
      : stageLabel(status));

  return (
    <main
      ref={hostMiniRef}
      className={`dictation-host-mini ${expanded ? "dictation-host-mini--expanded" : ""}`}
      data-status={status}
    >
      <button
        type="button"
        aria-label={status === "capturing" ? "Stop dictation" : "Start dictation"}
        className="dictation-host-mini__control"
        // Requesting permission stays enabled so a second click can cancel a
        // capture still waiting on WebKit. Only server finalization blocks it.
        disabled={blocksNewPress}
        onClick={() => {
          const action = dictationClickAction(status);
          if (action === "start") begin(false);
          else if (action === "stop") end();
        }}
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
      </button>
      {expanded ? (
        <section className="dictation-host-mini__content" aria-live="polite">
          <p className={`dictation-host-mini__stage ${errorMessage ? "dictation-host-mini__stage--error" : ""}`}>
            {hostStage}
          </p>
          {status === "capturing" ? (
            <div className="dictation-host-mini__meter">
              <VuMeter rms={meter.rms} peak={meter.peak} />
            </div>
          ) : null}
          {transcript && status !== "complete" ? (
            <p className="dictation-host-mini__transcript">{transcript}</p>
          ) : null}
        </section>
      ) : null}
    </main>
  );
}
