/**
 * @vitest-environment jsdom
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { VoiceRecorder } from "@/features/voice/components/voice-recorder";
import { useVoiceStore } from "@/stores/voice-store";
import type { PracticePassage } from "@/lib/wire";

const session = vi.hoisted(() => ({
  reset: vi.fn(),
  startRecording: vi.fn().mockResolvedValue(undefined),
  stopRecording: vi.fn(),
}));
const referenceSpeech = vi.hoisted(() => ({ stop: vi.fn() }));

vi.mock("@/features/voice/use-voice-session", () => ({
  useVoiceSession: () => session,
}));

vi.mock("@/features/voice/components/microphone-selector", () => ({
  MicrophoneSelector: () => (
    <div aria-label="Microphone">System default</div>
  ),
}));

vi.mock("@/features/voice/reference-speech", () => ({
  stopReferenceSpeech: referenceSpeech.stop,
}));

const passage: PracticePassage = {
  id: `passage-${"1".repeat(32)}`,
  intendedText: "Hello. How are you?",
  revision: 1,
  createdAt: "2026-07-31T00:00:00Z",
  updatedAt: "2026-07-31T00:00:00Z",
  baselineRecordingID: null,
  attemptCount: 0,
  latestAttemptCreatedAt: null,
};

beforeEach(() => {
  useVoiceStore.getState().reset();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("keeps Reset visible and clears the selected passage context", () => {
  const onNewPassage = vi.fn();
  render(
    <VoiceRecorder
      passage={passage}
      onComplete={vi.fn()}
      onNewPassage={onNewPassage}
    />,
  );

  expect(screen.getByRole("button", { name: "Reset" })).toBeTruthy();
  expect(screen.getByLabelText("Microphone").textContent).toContain(
    "System default",
  );
  expect(screen.getByText("Practice reference")).toBeTruthy();
  expect(screen.getByText("Hello. How are you?")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Reset" }));
  expect(referenceSpeech.stop).toHaveBeenCalledOnce();
  expect(session.reset).toHaveBeenCalledOnce();
  expect(onNewPassage).toHaveBeenCalledOnce();
});

it("keeps every recorder action without a passive new-passage callout", () => {
  render(
    <VoiceRecorder onComplete={vi.fn()} onNewPassage={vi.fn()} />,
  );

  expect(screen.queryByText("New passage")).toBeNull();
  expect(
    screen.queryByText(
      "Record freely. The machine transcript will seed intended text for your review.",
    ),
  ).toBeNull();
  expect(screen.getByRole("button", { name: "Record" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Reset" })).toBeTruthy();
  expect(screen.getByLabelText("Microphone")).toBeTruthy();
});
