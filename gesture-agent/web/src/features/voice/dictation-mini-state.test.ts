import { expect, test } from "vitest";

import {
  DICTATION_TERMINAL_DISMISS_MS,
  applyDictationPrefix,
  dictationClickAction,
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

test("the mic button toggles a run rather than holding it", () => {
  expect(dictationClickAction("idle")).toBe("start");
  expect(dictationClickAction("complete")).toBe("start");
  expect(dictationClickAction("error")).toBe("start");
  // A click that lands while WebKit is still resolving permission cancels the
  // pending run; without this the only escape is waiting for it to fail.
  expect(dictationClickAction("requestingMic")).toBe("stop");
  expect(dictationClickAction("capturing")).toBe("stop");
  expect(dictationClickAction("saving")).toBe("ignore");
  expect(dictationClickAction("transcribing")).toBe("ignore");
  expect(dictationClickAction("analyzing")).toBe("ignore");
});

test("only a nonempty, not-yet-committed recording can insert text", () => {
  const committed = new Set(["session-1"]);
  expect(shouldCommitDictation(committed, "session-1", "hello")).toBe(false);
  expect(shouldCommitDictation(committed, "session-2", "   ")).toBe(false);
  expect(shouldCommitDictation(committed, "session-2", "!!!!!!!!")).toBe(false);
  expect(shouldCommitDictation(committed, "session-2", null)).toBe(false);
  expect(shouldCommitDictation(committed, "session-2", "hello")).toBe(true);
  expect(shouldCommitDictation(committed, "session-2", "你好")).toBe(true);
  expect(shouldCommitDictation(committed, "session-2", "123")).toBe(true);
});

test("recording prefix changes only an enabled explicit send", () => {
  expect(applyDictationPrefix("  hello  ", false, "Dictated:")).toBe("hello");
  expect(applyDictationPrefix("  hello  ", true, " Dictated: ")).toBe(
    "Dictated: hello",
  );
  expect(applyDictationPrefix("hello", true, "   ")).toBe("hello");
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
