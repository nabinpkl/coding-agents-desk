export const MICROPHONE_MUTE_GRACE_MS = 1_500;

export interface MicrophoneTrackDiagnostics {
  readonly readyState: MediaStreamTrackState;
  readonly muted: boolean;
  readonly settings: {
    readonly sampleRate: number | undefined;
    readonly sampleSize: number | undefined;
    readonly channelCount: number | undefined;
    readonly echoCancellation: boolean | undefined;
    readonly noiseSuppression: boolean | undefined;
    readonly autoGainControl: boolean | undefined;
  };
}

/** Report what the browser applied without logging origin-scoped device IDs. */
export function microphoneTrackDiagnostics(
  track: MediaStreamTrack,
): MicrophoneTrackDiagnostics {
  const settings = track.getSettings();
  return {
    readyState: track.readyState,
    muted: track.muted,
    settings: {
      sampleRate: settings.sampleRate,
      sampleSize: settings.sampleSize,
      channelCount: settings.channelCount,
      echoCancellation: settings.echoCancellation,
      noiseSuppression: settings.noiseSuppression,
      autoGainControl: settings.autoGainControl,
    },
  };
}

/**
 * Observe permanent track loss and temporary WebKit muting.
 *
 * A short grace period avoids failing a capture for a transient route switch.
 * WebKit keeps producing silent frames while muted, so frame arrival cannot
 * serve as this health signal.
 */
export function observeMicrophoneTrackHealth(
  track: MediaStreamTrack,
  onFailure: (message: string) => void,
): () => void {
  let muteTimer: ReturnType<typeof setTimeout> | null = null;

  const cancelMuteTimer = () => {
    if (muteTimer === null) return;
    clearTimeout(muteTimer);
    muteTimer = null;
  };
  const onMute = () => {
    cancelMuteTimer();
    muteTimer = setTimeout(() => {
      muteTimer = null;
      if (track.muted) {
        onFailure("microphone input remained muted");
      }
    }, MICROPHONE_MUTE_GRACE_MS);
  };
  const onUnmute = () => {
    cancelMuteTimer();
  };
  const onEnded = () => {
    onFailure("microphone input ended unexpectedly");
  };

  track.addEventListener("mute", onMute);
  track.addEventListener("unmute", onUnmute);
  track.addEventListener("ended", onEnded);
  if (track.muted) {
    onMute();
  }

  return () => {
    cancelMuteTimer();
    track.removeEventListener("mute", onMute);
    track.removeEventListener("unmute", onUnmute);
    track.removeEventListener("ended", onEnded);
  };
}
