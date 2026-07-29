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

/**
 * The button is a toggle: one click starts a run, the next stops it. Holding
 * belongs to Fn, which starts on press and stops on release; a pointer cannot
 * express that without turning every ordinary click into an empty recording.
 * Server finalization owns the run until it lands, so a click during it does
 * nothing rather than queueing a second run.
 */
export function dictationClickAction(
  status: VoiceRunStatus,
): "start" | "stop" | "ignore" {
  switch (status) {
    case "requestingMic":
    case "capturing":
      return "stop";
    case "saving":
    case "transcribing":
    case "analyzing":
      return "ignore";
    case "idle":
    case "complete":
    case "error":
      return "start";
  }
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
 * The optional client prefix is presentation text for one explicit remote
 * keyboard send. It never changes the host-owned recording or transcript.
 */
export function applyDictationPrefix(
  transcript: string,
  isEnabled: boolean,
  prefix: string,
): string {
  const normalizedTranscript = transcript.trim();
  if (!isEnabled) return normalizedTranscript;

  const normalizedPrefix = prefix.trim();
  return normalizedPrefix
    ? `${normalizedPrefix} ${normalizedTranscript}`
    : normalizedTranscript;
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
