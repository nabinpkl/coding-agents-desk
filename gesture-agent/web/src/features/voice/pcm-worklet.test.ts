import vm from "node:vm";

import { expect, test } from "vitest";

import {
  PCM_FRAME_SAMPLES,
  PCM_WORKLET_SOURCE,
  type PcmWorkletMessage,
} from "@/features/voice/pcm-worklet";

interface WorkletHarness {
  readonly process: (inputs: Float32Array[][]) => boolean;
  readonly port: {
    onmessage: ((event: { data: unknown }) => void) | null;
  };
}

function makeProcessor(): {
  readonly processor: WorkletHarness;
  readonly messages: PcmWorkletMessage[];
} {
  let Processor:
    | (new () => WorkletHarness)
    | undefined;
  const messages: PcmWorkletMessage[] = [];
  class MockAudioWorkletProcessor {
    readonly port = {
      onmessage: null as ((event: { data: unknown }) => void) | null,
      postMessage: (message: PcmWorkletMessage) => {
        messages.push(message);
      },
    };
  }
  vm.runInNewContext(PCM_WORKLET_SOURCE, {
    AudioWorkletProcessor: MockAudioWorkletProcessor,
    Float32Array,
    Math,
    registerProcessor: (_name: string, implementation: new () => WorkletHarness) => {
      Processor = implementation;
    },
  });
  if (!Processor) throw new Error("worklet did not register");
  return { processor: new Processor(), messages };
}

test("flush emits the final short PCM frame before its acknowledgement", () => {
  const { processor, messages } = makeProcessor();
  const tail = new Float32Array(317).fill(0.25);

  expect(processor.process([[tail]])).toBe(true);
  expect(messages).toEqual([]);
  processor.port.onmessage?.({
    data: { type: "flush", requestID: "flush-1" },
  });

  expect(messages.map((message) => message.type)).toEqual(["frame", "flushed"]);
  const frame = messages[0];
  expect(frame.type).toBe("frame");
  if (frame.type === "frame") {
    expect(new Float32Array(frame.pcm)).toHaveLength(317);
  }
  expect(messages[1]).toEqual({ type: "flushed", requestID: "flush-1" });
});

test("flush fences later render callbacks", () => {
  const { processor, messages } = makeProcessor();
  processor.process([[new Float32Array(PCM_FRAME_SAMPLES).fill(0.1)]]);
  processor.port.onmessage?.({
    data: { type: "flush", requestID: "flush-2" },
  });
  processor.process([[new Float32Array(PCM_FRAME_SAMPLES).fill(0.2)]]);

  expect(messages.map((message) => message.type)).toEqual(["frame", "flushed"]);
});
