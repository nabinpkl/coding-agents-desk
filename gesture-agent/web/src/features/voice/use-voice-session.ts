/**
 * Orchestrates one live voice run end to end. This is where the three moving
 * parts meet: the mic capture graph (`use-mic-capture`), the typed audio socket
 * (`@/lib/ws`), and the momentum/truth split (Zustand store + Query cache).
 *
 * Momentum: partial/final transcript and meter land in the Zustand store while
 * the run is live. Truth handshake: on `sessionComplete` the persisted
 * recording exists on the server, so we invalidate the recordings query (truth
 * appears) and the store drops its live transcript. Views stay dumb; every
 * transition lives here.
 */

"use client";

import { useCallback, useEffect, useRef } from "react";

import { useQueryClient } from "@tanstack/react-query";

import { useMicCapture } from "@/features/voice/use-mic-capture";
import { RECORDINGS_QUERY_KEY } from "@/features/voice/use-recordings";
import { useVoiceStore } from "@/stores/voice-store";
import { VoiceSocket } from "@/lib/ws";
import type { ServerWireMessage } from "@/lib/wire";

export interface VoiceSessionController {
  /** idle/complete/error -> start a fresh live run. */
  startRecording: () => Promise<void>;
  /** capturing -> stop the mic and wait for the server to persist. */
  stopRecording: () => void;
  /** Return to idle from a terminal state; releases any lingering resources. */
  reset: () => void;
}

export function useVoiceSession(): VoiceSessionController {
  const queryClient = useQueryClient();
  const capture = useMicCapture();
  const socketRef = useRef<VoiceSocket | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);

  const teardownSocket = useCallback(() => {
    unsubscribeRef.current?.();
    unsubscribeRef.current = null;
    socketRef.current?.close();
    socketRef.current = null;
  }, []);

  const handleServerMessage = useCallback(
    (message: ServerWireMessage) => {
      const store = useVoiceStore.getState();
      switch (message.type) {
        case "partialTranscript":
          store.setPartialTranscript(message.text);
          break;
        case "finalTranscript":
          store.setFinalTranscript(message.text);
          break;
        case "meter":
          // The VU meter is driven by the local worklet (use-mic-capture) for
          // low latency. The server meter is ignored so two writers never fight
          // over the same store field.
          break;
        case "sessionComplete":
          // Momentum -> truth: the recording is persisted, so refetch the
          // truth cache and let the store clear its live transcript.
          void queryClient.invalidateQueries({
            queryKey: RECORDINGS_QUERY_KEY,
          });
          store.complete(message.recordingId);
          teardownSocket();
          capture.stop();
          break;
        default:
          break;
      }
    },
    [capture, queryClient, teardownSocket],
  );

  // An unexpected socket close (backend error-close, dropped connection) while
  // a run is live must fail loud, or the UI would sit in `decoding`/`capturing`
  // forever with no enabled control to recover.
  const handleSocketClose = useCallback(
    (event: CloseEvent) => {
      const store = useVoiceStore.getState();
      const status = store.runState.status;
      if (
        status === "requestingMic" ||
        status === "capturing" ||
        status === "decoding"
      ) {
        capture.stop();
        teardownSocket();
        store.fail(event.reason || `voice socket closed (code ${event.code})`);
      }
    },
    [capture, teardownSocket],
  );

  const startRecording = useCallback(async () => {
    const store = useVoiceStore.getState();
    const status = store.runState.status;
    // Guard against re-entry: a run already in flight owns the socket/mic.
    if (
      status === "requestingMic" ||
      status === "capturing" ||
      status === "decoding"
    ) {
      return;
    }
    // Release any socket lingering from a prior terminal run before opening one.
    teardownSocket();
    // A live run owns the session mode; it is set once here, not folded into
    // the run-state union.
    store.setMode("live");
    store.requestMic();

    const socket = new VoiceSocket();
    socketRef.current = socket;
    const unsubMessage = socket.onMessage(handleServerMessage);
    const unsubClose = socket.onClose(handleSocketClose);
    unsubscribeRef.current = () => {
      unsubMessage();
      unsubClose();
    };

    try {
      await socket.connect();
      socket.sendControl({
        type: "sessionStart",
        preampGain: store.preampGain,
      });

      await capture.start({
        onFrame: (frame) => {
          const active = socketRef.current;
          if (!active || active.readyState !== WebSocket.OPEN) {
            return;
          }
          active.sendAudioFrame({
            type: "audioFrame",
            pcm: frame.pcm,
            sampleRate: frame.sampleRate,
            encoding: "float32",
          });
        },
        onMeter: (meter) => useVoiceStore.getState().setMeter(meter),
      });

      useVoiceStore.getState().beginCapture();
    } catch (error) {
      capture.stop();
      teardownSocket();
      const message =
        error instanceof Error ? error.message : "voice capture failed";
      useVoiceStore.getState().fail(message);
    }
  }, [capture, handleServerMessage, handleSocketClose, teardownSocket]);

  const stopRecording = useCallback(() => {
    const store = useVoiceStore.getState();
    if (store.runState.status !== "capturing") {
      return;
    }
    // Stop feeding frames, then hand off to the server for the final pass.
    capture.stop();
    const socket = socketRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.sendControl({ type: "sessionStop" });
      store.beginDecode();
    } else {
      store.fail("voice socket closed before decode");
      teardownSocket();
    }
  }, [capture, teardownSocket]);

  const reset = useCallback(() => {
    capture.stop();
    teardownSocket();
    useVoiceStore.getState().reset();
  }, [capture, teardownSocket]);

  // Release the socket subscription if the owning component unmounts.
  useEffect(() => teardownSocket, [teardownSocket]);

  // On unmount, the mic and socket are torn down by their own hooks, but the
  // global store would still describe a live run over dead resources. Reset any
  // non-terminal run-state so a remount does not present a frozen "recording".
  useEffect(
    () => () => {
      const store = useVoiceStore.getState();
      const status = store.runState.status;
      if (
        status === "requestingMic" ||
        status === "capturing" ||
        status === "decoding"
      ) {
        store.reset();
      }
    },
    [],
  );

  return { startRecording, stopRecording, reset };
}
