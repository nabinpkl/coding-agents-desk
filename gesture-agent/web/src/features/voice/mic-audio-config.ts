/**
 * The capture constraints one microphone run opens with, and the host's live
 * answer for the one constraint this bundle cannot decide for itself.
 *
 * macOS implements `echoCancellation` with a voice-processing audio unit that
 * takes the OUTPUT device as its echo reference and mutes the speakers for as
 * long as it runs. That is only worth paying when the microphone belongs to the
 * same machine as those speakers, which the web side cannot see: WebKit does
 * not expose output devices, and its input device ids are origin-scoped hashes
 * that no native device identity matches. So the host decides, injects the
 * answer at document start, and revises it with a `voiceAudioConfig` delivery
 * when the default input device changes.
 */

import { getHostConfig } from "@/lib/host-bridge";
import { subscribeInteractionDelivery } from "@/lib/interaction-delivery";

/** A plain browser has no host to ask, and no speaker-muting problem either. */
const DEFAULT_ECHO_CANCELLATION = true;

type VoiceAudioConfig = { readonly echoCancellation?: unknown };

let echoCancellation = readInjectedEchoCancellation();

function readInjectedEchoCancellation(): boolean {
  const injected = getHostConfig()?.audio?.echoCancellation;
  return typeof injected === "boolean" ? injected : DEFAULT_ECHO_CANCELLATION;
}

/** The answer a capture starting right now should use. */
export function currentEchoCancellation(): boolean {
  return echoCancellation;
}

/** Exported for tests; the running app is revised by the host delivery. */
export function setEchoCancellation(enabled: boolean): void {
  echoCancellation = enabled;
}

export function resetEchoCancellationToInjected(): void {
  echoCancellation = readInjectedEchoCancellation();
}

/**
 * Follow the host's revisions. A payload without a boolean is ignored rather
 * than treated as false, so a malformed push cannot silently disable echo
 * cancellation on the built-in microphone.
 */
export function subscribeHostAudioConfig(): () => void {
  return subscribeInteractionDelivery<VoiceAudioConfig>(
    "voiceAudioConfig",
    (payload) => {
      if (typeof payload?.echoCancellation === "boolean") {
        echoCancellation = payload.echoCancellation;
      }
    },
  );
}

export function micAudioConstraints(
  echoCancellationEnabled: boolean,
  deviceID?: string,
): MediaTrackConstraints {
  return {
    channelCount: 1,
    ...(deviceID ? { deviceId: { exact: deviceID } } : {}),
    echoCancellation: echoCancellationEnabled,
    noiseSuppression: true,
    autoGainControl: false,
  };
}
