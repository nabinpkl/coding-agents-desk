import { afterEach, expect, test, vi } from "vitest";

import {
  MICROPHONE_MUTE_GRACE_MS,
  microphoneTrackDiagnostics,
  observeMicrophoneTrackHealth,
} from "@/features/voice/mic-track-health";

class FakeMicrophoneTrack extends EventTarget {
  muted = false;
  readyState: MediaStreamTrackState = "live";

  getSettings(): MediaTrackSettings {
    return {
      sampleRate: 48_000,
      sampleSize: 32,
      channelCount: 1,
      echoCancellation: false,
      noiseSuppression: true,
      autoGainControl: false,
    };
  }
}

afterEach(() => {
  vi.useRealTimers();
});

test("track diagnostics report the settings WebKit actually applied", () => {
  const track = new FakeMicrophoneTrack();

  expect(
    microphoneTrackDiagnostics(track as unknown as MediaStreamTrack),
  ).toEqual({
    readyState: "live",
    muted: false,
    settings: {
      sampleRate: 48_000,
      sampleSize: 32,
      channelCount: 1,
      echoCancellation: false,
      noiseSuppression: true,
      autoGainControl: false,
    },
  });
});

test("a sustained mute fails even while silent worklet frames continue", () => {
  vi.useFakeTimers();
  const track = new FakeMicrophoneTrack();
  const failures: string[] = [];
  const remove = observeMicrophoneTrackHealth(
    track as unknown as MediaStreamTrack,
    (message) => failures.push(message),
  );

  track.muted = true;
  track.dispatchEvent(new Event("mute"));
  vi.advanceTimersByTime(MICROPHONE_MUTE_GRACE_MS);

  expect(failures).toEqual(["microphone input remained muted"]);
  remove();
});

test("a transient mute cleared by unmute does not fail capture", () => {
  vi.useFakeTimers();
  const track = new FakeMicrophoneTrack();
  const failures: string[] = [];
  const remove = observeMicrophoneTrackHealth(
    track as unknown as MediaStreamTrack,
    (message) => failures.push(message),
  );

  track.muted = true;
  track.dispatchEvent(new Event("mute"));
  vi.advanceTimersByTime(MICROPHONE_MUTE_GRACE_MS - 1);
  track.muted = false;
  track.dispatchEvent(new Event("unmute"));
  vi.advanceTimersByTime(MICROPHONE_MUTE_GRACE_MS);

  expect(failures).toEqual([]);
  remove();
});

test("an ended track fails immediately", () => {
  const track = new FakeMicrophoneTrack();
  const failures: string[] = [];
  const remove = observeMicrophoneTrackHealth(
    track as unknown as MediaStreamTrack,
    (message) => failures.push(message),
  );

  track.readyState = "ended";
  track.dispatchEvent(new Event("ended"));

  expect(failures).toEqual(["microphone input ended unexpectedly"]);
  remove();
});
