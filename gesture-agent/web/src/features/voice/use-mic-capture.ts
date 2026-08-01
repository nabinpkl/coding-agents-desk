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

import { useCallback, useEffect, useRef } from "react";

import { encodeFloat32Pcm } from "@/features/voice/base64";
import {
  currentEchoCancellation,
  micAudioConstraints,
  subscribeHostAudioConfig,
} from "@/features/voice/mic-audio-config";
import {
  PCM_WORKLET_SOURCE,
  type PcmWorkletFrame,
} from "@/features/voice/pcm-worklet";
import type { VoiceMeter } from "@/stores/voice-store";

/** Sample rate we ask the browser for; matches the Sherpa model input rate. */
const TARGET_SAMPLE_RATE = 16_000;

export interface MicFrame {
  /** Base64 little-endian Float32 samples, ready for `audioFrame.pcm`. */
  readonly pcm: string;
  readonly sampleRate: number;
}

export interface MicCaptureHandlers {
  readonly onFrame: (frame: MicFrame) => void;
  readonly onMeter: (meter: VoiceMeter) => void;
}

export class MicCaptureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MicCaptureError";
  }
}

interface MicGraph {
  readonly context: AudioContext;
  readonly stream: MediaStream;
  readonly source: MediaStreamAudioSourceNode;
  readonly worklet: AudioWorkletNode;
  readonly sink: GainNode;
  readonly moduleUrl: string;
}

export interface MicCaptureController {
  /** Acquire the mic and start streaming frames. Rejects loudly on failure. */
  start: (handlers: MicCaptureHandlers) => Promise<void>;
  /** Stop streaming and release the mic and audio graph. Idempotent. */
  stop: () => void;
}

export function useMicCapture(): MicCaptureController {
  const graphRef = useRef<MicGraph | null>(null);

  const stop = useCallback(() => {
    const graph = graphRef.current;
    if (!graph) {
      return;
    }
    graphRef.current = null;

    graph.worklet.port.onmessage = null;
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
        worklet.port.onmessage = (event: MessageEvent<PcmWorkletFrame>) => {
          const { pcm, rms, peak } = event.data;
          const samples = new Float32Array(pcm);
          handlers.onFrame({ pcm: encodeFloat32Pcm(samples), sampleRate });
          handlers.onMeter({ rms, peak });
        };

        source.connect(worklet);
        worklet.connect(sink);
        sink.connect(context.destination);

        graphRef.current = {
          context,
          stream,
          source,
          worklet,
          sink,
          moduleUrl,
        };
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
    [],
  );

  // Guarantee the mic is released if the owning component unmounts mid-run.
  useEffect(() => stop, [stop]);

  // Follow the host's echo-cancellation answer for as long as this surface can
  // start a capture; the next run picks up whatever the last push said.
  useEffect(subscribeHostAudioConfig, []);

  return { start, stop };
}
