import { afterAll, afterEach, beforeAll, expect, test } from "vitest";

import {
  currentEchoCancellation,
  micAudioConstraints,
  resetEchoCancellationToInjected,
  setEchoCancellation,
  subscribeHostAudioConfig,
} from "@/features/voice/mic-audio-config";

type TestWindow = typeof globalThis & {
  __interactionDeliver?: (delivery: unknown) => void;
};

const testWindow = globalThis as TestWindow;

beforeAll(() => {
  Object.defineProperty(globalThis, "window", {
    value: globalThis,
    configurable: true,
  });
});

afterAll(() => {
  delete testWindow.__interactionDeliver;
  Reflect.deleteProperty(globalThis, "window");
});

afterEach(() => {
  resetEchoCancellationToInjected();
});

test("capture constraints carry the host's echo cancellation answer", () => {
  expect(micAudioConstraints(false)).toEqual({
    channelCount: 1,
    echoCancellation: false,
    noiseSuppression: true,
    autoGainControl: false,
  });
  expect(micAudioConstraints(true).echoCancellation).toBe(true);
});

test("a plain browser with no host config cancels echo", () => {
  expect(currentEchoCancellation()).toBe(true);
});

test("a host push revises the answer for the next capture", () => {
  const unsubscribe = subscribeHostAudioConfig();
  testWindow.__interactionDeliver?.({
    type: "voiceAudioConfig",
    payload: { echoCancellation: false },
  });
  expect(currentEchoCancellation()).toBe(false);
  unsubscribe();
});

test("a malformed push is ignored rather than read as disabled", () => {
  const unsubscribe = subscribeHostAudioConfig();
  setEchoCancellation(true);
  testWindow.__interactionDeliver?.({
    type: "voiceAudioConfig",
    payload: { echoCancellation: "no" },
  });
  expect(currentEchoCancellation()).toBe(true);
  unsubscribe();
});
