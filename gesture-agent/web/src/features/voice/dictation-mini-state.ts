import type { VoiceRunStatus } from "@/stores/voice-store";

export const DICTATION_TERMINAL_DISMISS_MS = 4_000;

export function isDictationRunActive(status: VoiceRunStatus): boolean {
  return (
    status === "requestingMic" ||
    status === "capturing" ||
    status === "saving" ||
    status === "transcribing" ||
    status === "analyzing"
  );
}

export function isDictationMiniExpanded(status: VoiceRunStatus): boolean {
  return status !== "idle";
}

/** Returns whether a persisted recording may cause a native text insertion. */
export function shouldCommitDictation(
  committedRecordingIDs: ReadonlySet<string>,
  recordingID: string,
  transcript: string | null | undefined,
): boolean {
  return !!transcript?.trim() && !committedRecordingIDs.has(recordingID);
}

/**
 * Fn can begin a capture before WebKit has received a direct user gesture.
 * Only that denial needs the click-to-enable guidance. Server failures, most
 * importantly recorder contention with the full Voice panel, stay intact.
 */
export function dictationErrorMessage(
  nativeStart: boolean,
  message: string,
): string {
  if (
    nativeStart &&
    /notallowederror|permission\s+(?:denied|disallowed)|user\s+denied|not\s+allowed/i.test(
      message,
    )
  ) {
    return "Click the mic to enable microphone.";
  }
  return message;
}
