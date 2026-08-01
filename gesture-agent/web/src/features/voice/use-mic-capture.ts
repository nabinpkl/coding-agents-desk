/**
 * Low-level microphone capture. Owns the Web Audio graph and nothing else: it
 * knows how to turn a mic permission into a stream of Float32 PCM frames plus a
 * live meter, and how to tear that graph down cleanly. It holds no run-state,
 * no socket, no transcript. Higher layers (`use-voice-session`) decide what to
 * do with the frames.
 *
 * Graph: MediaStreamSource -> AudioWorklet(pcm-frame-processor) -> muted sink.
 * The worklet must sit in a graph with a destination for the render thread to
 * pull audio, so it feeds a zero-gain node into the context destination (no
 * audible monitoring / echo).
 */

"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";

import { encodeFloat32Pcm } from "@/features/voice/base64";
import {
  currentEchoCancellation,
  micAudioConstraints,
  subscribeHostAudioConfig,
} from "@/features/voice/mic-audio-config";
import {
  PCM_WORKLET_SOURCE,
  type PcmWorkletMessage,
} from "@/features/voice/pcm-worklet";
import type { VoiceMeter } from "@/stores/voice-store";

/** Sample rate we ask the browser for; matches the Sherpa model input rate. */
const TARGET_SAMPLE_RATE = 16_000;

export interface MicFrame {
  /** Base64 little-endian Float32 samples, ready for `audioFrame.pcm`. */
  readonly pcm: string;
  readonly sampleRate: number;
  readonly sampleCount: number;
}

export interface MicCaptureHandlers {
  readonly onFrame: (frame: MicFrame) => void;
  readonly onMeter: (meter: VoiceMeter) => void;
  readonly onFailure: (error: MicCaptureError) => void;
}

export class MicCaptureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MicCaptureError";
  }
}

interface PendingFlush {
  readonly requestID: string;
  readonly resolve: () => void;
  readonly reject: (error: MicCaptureError) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
}

interface MicGraph {
  readonly context: AudioContext;
  readonly stream: MediaStream;
  readonly source: MediaStreamAudioSourceNode;
  readonly worklet: AudioWorkletNode;
  readonly sink: GainNode;
  readonly moduleUrl: string;
  readonly removeHealthObservers: () => void;
  watchdog: ReturnType<typeof setInterval> | null;
  lastFrameAt: number;
  stopping: boolean;
  stopPromise: Promise<void> | null;
  pendingFlush: PendingFlush | null;
}

export interface MicCaptureController {
  /** Acquire the mic and start streaming frames. Rejects loudly on failure. */
  start: (handlers: MicCaptureHandlers) => Promise<void>;
  /** Stop streaming and release the mic and audio graph. Idempotent. */
  stop: () => Promise<void>;
  /** Release immediately after cancellation or failure without claiming a clean fence. */
  abort: () => void;
}

export function useMicCapture(): MicCaptureController {
  const graphRef = useRef<MicGraph | null>(null);

  const tearDownGraph = useCallback((graph: MicGraph) => {
    graph.removeHealthObservers();
    if (graph.watchdog !== null) {
      clearInterval(graph.watchdog);
      graph.watchdog = null;
    }
    if (graph.pendingFlush) {
      const pending = graph.pendingFlush;
      clearTimeout(pending.timeout);
      graph.pendingFlush = null;
      pending.reject(new MicCaptureError("microphone flush was cancelled"));
    }
    graph.worklet.port.onmessage = null;
    graph.worklet.onprocessorerror = null;
    try {
      graph.worklet.disconnect();
      graph.sink.disconnect();
      graph.source.disconnect();
    } catch {
      // Nodes may already be detached; tearing down is best-effort.
    }
    for (const track of graph.stream.getTracks()) {
      track.stop();
    }
    void graph.context.close();
    URL.revokeObjectURL(graph.moduleUrl);
  }, []);

  const abort = useCallback(() => {
    const graph = graphRef.current;
    if (!graph) return;
    graphRef.current = null;
    graph.stopping = true;
    tearDownGraph(graph);
  }, [tearDownGraph]);

  const stop = useCallback(async () => {
    const graph = graphRef.current;
    if (!graph) return;
    if (graph.stopPromise) {
      await graph.stopPromise;
      return;
    }
    graph.stopping = true;
    if (graph.watchdog !== null) {
      clearInterval(graph.watchdog);
      graph.watchdog = null;
    }
    const requestID = crypto.randomUUID();
    graph.stopPromise = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (graph.pendingFlush?.requestID !== requestID) return;
        graph.pendingFlush = null;
        reject(new MicCaptureError("microphone flush timed out"));
      }, 1_500);
      graph.pendingFlush = { requestID, resolve, reject, timeout };
      graph.worklet.port.postMessage({ type: "flush", requestID });
    });
    try {
      await graph.stopPromise;
    } finally {
      if (graphRef.current === graph) {
        graphRef.current = null;
      }
      tearDownGraph(graph);
    }
  }, [tearDownGraph]);

  const start = useCallback(
    async (handlers: MicCaptureHandlers) => {
      if (graphRef.current) {
        throw new MicCaptureError("capture already running");
      }
      if (typeof navigator === "undefined" || !navigator.mediaDevices) {
        throw new MicCaptureError("microphone capture is not available");
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: micAudioConstraints(currentEchoCancellation()),
      });

      const context = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });
      const moduleUrl = URL.createObjectURL(
        new Blob([PCM_WORKLET_SOURCE], { type: "application/javascript" }),
      );

      try {
        await context.audioWorklet.addModule(moduleUrl);
        if (context.state === "suspended") {
          await context.resume();
        }

        const source = context.createMediaStreamSource(stream);
        const worklet = new AudioWorkletNode(context, "pcm-frame-processor", {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          channelCount: 1,
        });
        const sink = context.createGain();
        sink.gain.value = 0;

        const sampleRate = context.sampleRate;
        let removeHealthObservers = () => {};
        const graph: MicGraph = {
          context,
          stream,
          source,
          worklet,
          sink,
          moduleUrl,
          removeHealthObservers: () => removeHealthObservers(),
          watchdog: null,
          lastFrameAt: performance.now(),
          stopping: false,
          stopPromise: null,
          pendingFlush: null,
        };
        const failCapture = (message: string) => {
          if (graphRef.current !== graph || graph.stopping) return;
          graphRef.current = null;
          graph.stopping = true;
          tearDownGraph(graph);
          handlers.onFailure(new MicCaptureError(message));
        };
        worklet.port.onmessage = (event: MessageEvent<PcmWorkletMessage>) => {
          const message = event.data;
          if (message.type === "flushed") {
            const pending = graph.pendingFlush;
            if (!pending || pending.requestID !== message.requestID) return;
            clearTimeout(pending.timeout);
            graph.pendingFlush = null;
            pending.resolve();
            return;
          }
          graph.lastFrameAt = performance.now();
          const samples = new Float32Array(message.pcm);
          handlers.onFrame({
            pcm: encodeFloat32Pcm(samples),
            sampleRate,
            sampleCount: samples.length,
          });
          handlers.onMeter({ rms: message.rms, peak: message.peak });
        };
        worklet.onprocessorerror = () => {
          failCapture("microphone audio processor failed");
        };
        const trackEndHandlers = stream.getTracks().map((track) => {
          const onEnded = () => failCapture("microphone input ended unexpectedly");
          track.addEventListener("ended", onEnded);
          return () => track.removeEventListener("ended", onEnded);
        });
        const onContextStateChange = () => {
          if (graph.stopping || context.state === "running") return;
          if (context.state === "suspended") {
            void context
              .resume()
              .then(() => {
                if (context.state !== "running") {
                  failCapture("microphone audio context remained suspended");
                }
              })
              .catch(() => {
                failCapture("microphone audio context was suspended");
              });
            return;
          }
          failCapture(`microphone audio context became ${context.state}`);
        };
        context.addEventListener("statechange", onContextStateChange);
        removeHealthObservers = () => {
          for (const remove of trackEndHandlers) remove();
          context.removeEventListener("statechange", onContextStateChange);
        };

        source.connect(worklet);
        worklet.connect(sink);
        sink.connect(context.destination);

        graphRef.current = graph;
        graph.watchdog = setInterval(() => {
          if (
            graphRef.current === graph &&
            !graph.stopping &&
            performance.now() - graph.lastFrameAt > 1_500
          ) {
            failCapture("microphone stopped producing audio frames");
          }
        }, 500);
      } catch (error) {
        for (const track of stream.getTracks()) {
          track.stop();
        }
        void context.close();
        URL.revokeObjectURL(moduleUrl);
        throw error instanceof Error
          ? new MicCaptureError(error.message)
          : new MicCaptureError("failed to start microphone capture");
      }
    },
    [tearDownGraph],
  );

  // Guarantee the mic is released if the owning component unmounts mid-run.
  useEffect(() => abort, [abort]);

  // Follow the host's echo-cancellation answer for as long as this surface can
  // start a capture; the next run picks up whatever the last push said.
  useEffect(subscribeHostAudioConfig, []);

  // A fresh object here would give every caller above a new identity on every
  // render, and each of them feeds effect dependencies. That churn is invisible
  // in a browser and expensive in a panel: the dictation mini re-subscribed and
  // re-announced itself to the native host on every meter tick.
  return useMemo(() => ({ start, stop, abort }), [abort, start, stop]);
}
