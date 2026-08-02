import { expect, test } from "vitest";

import {
  DICTATION_TERMINAL_DISMISS_MS,
  dictationErrorMessage,
  isDictationMiniExpanded,
  isDictationRunActive,
  shouldCommitDictation,
} from "@/features/voice/dictation-mini-state";

test("dictation owns the recorder only through capture and finalization", () => {
  expect(isDictationRunActive("idle")).toBe(false);
  expect(isDictationRunActive("requestingMic")).toBe(true);
  expect(isDictationRunActive("capturing")).toBe(true);
  expect(isDictationRunActive("saving")).toBe(true);
  expect(isDictationRunActive("transcribing")).toBe(true);
  expect(isDictationRunActive("analyzing")).toBe(true);
  expect(isDictationRunActive("complete")).toBe(false);
  expect(isDictationRunActive("error")).toBe(false);
});

test("dictation stays expanded for completion and errors before auto-collapse", () => {
  expect(isDictationMiniExpanded("idle")).toBe(false);
  expect(isDictationMiniExpanded("capturing")).toBe(true);
  expect(isDictationMiniExpanded("complete")).toBe(true);
  expect(isDictationMiniExpanded("error")).toBe(true);
  expect(DICTATION_TERMINAL_DISMISS_MS).toBe(4_000);
});

test("only a nonempty, not-yet-committed recording can insert text", () => {
  const committed = new Set(["session-1"]);
  expect(shouldCommitDictation(committed, "session-1", "hello")).toBe(false);
  expect(shouldCommitDictation(committed, "session-2", "   ")).toBe(false);
  expect(shouldCommitDictation(committed, "session-2", null)).toBe(false);
  expect(shouldCommitDictation(committed, "session-2", "hello")).toBe(true);
});

test("only native microphone permission errors receive click guidance", () => {
  expect(
    dictationErrorMessage(true, "NotAllowedError: Permission denied"),
  ).toBe("Click the mic to enable microphone.");
  expect(dictationErrorMessage(true, "recorderBusy")).toBe("recorderBusy");
  expect(dictationErrorMessage(false, "Permission denied")).toBe(
    "Permission denied",
  );
});
