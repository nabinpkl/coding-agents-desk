import {
  createReferenceSpeechArtifact,
  referenceSpeechAudioUrl,
} from "@/lib/api";
import {
  INTERACTION_HANDLER,
  getHostConfig,
  postToHost,
} from "@/lib/host-bridge";
import { subscribeInteractionDelivery } from "@/lib/interaction-delivery";
import type { ReferenceSpeechPreferences } from "@/features/voice/reference-speech-settings";
import type { ReferenceSpeechScopeRequest } from "@/lib/wire";

export type ReferenceSpeechPlaybackStatus =
  | "idle"
  | "preparing"
  | "playing"
  | "error";

export interface ReferenceSpeechPlaybackState {
  status: ReferenceSpeechPlaybackStatus;
  requestKey?: string;
  error?: string;
}

interface NativeReferenceAudioEvent {
  artifactID?: string | null;
  status: "preparing" | "playing" | "completed" | "stopped" | "failed";
  error?: string | null;
}

let generation = 0;
let activeAudio: HTMLAudioElement | undefined;
let activeArtifactID: string | undefined;
let state: ReferenceSpeechPlaybackState = { status: "idle" };
const listeners = new Set<() => void>();
let nativeDeliveryInstalled = false;

function publish(next: ReferenceSpeechPlaybackState): void {
  state = next;
  for (const listener of listeners) listener();
}

function ensureNativeDelivery(): void {
  if (nativeDeliveryInstalled || typeof window === "undefined") return;
  nativeDeliveryInstalled = true;
  subscribeInteractionDelivery<NativeReferenceAudioEvent>(
    "referenceAudioState",
    (event) => {
      if (
        !activeArtifactID ||
        !event.artifactID ||
        event.artifactID !== activeArtifactID
      ) {
        return;
      }
      if (event.status === "preparing") return;
      if (event.status === "playing") {
        publish({ ...state, status: "playing", error: undefined });
      } else if (event.status === "failed") {
        activeArtifactID = undefined;
        publish({
          status: "error",
          requestKey: state.requestKey,
          error: event.error ?? "Reference audio playback failed.",
        });
      } else {
        activeArtifactID = undefined;
        publish({ status: "idle" });
      }
    },
  );
}

export function subscribeReferenceSpeechPlayback(listener: () => void): () => void {
  listeners.add(listener);
  ensureNativeDelivery();
  return () => listeners.delete(listener);
}

export function referenceSpeechPlaybackSnapshot(): ReferenceSpeechPlaybackState {
  return state;
}

export async function speakReference(
  recordingID: string,
  scope: ReferenceSpeechScopeRequest,
  preferences: ReferenceSpeechPreferences,
): Promise<void> {
  stopReferenceSpeech();
  const requestGeneration = ++generation;
  const requestKey =
    scope.kind === "passage"
      ? `${recordingID}:passage`
      : `${recordingID}:word:${scope.index ?? -1}`;
  publish({ status: "preparing", requestKey });
  try {
    const artifact = await createReferenceSpeechArtifact({
      recordingId: recordingID,
      scope,
      voiceIdentifier: preferences.voiceIdentifier,
      speed: preferences.speed,
    });
    if (generation !== requestGeneration) return;
    if (getHostConfig()?.voiceTransport === "native") {
      ensureNativeDelivery();
      activeArtifactID = artifact.id;
      postToHost(INTERACTION_HANDLER, {
        t: "referenceAudioPlay",
        artifactID: artifact.id,
        audioHash: artifact.audioHash,
      });
      return;
    }

    const audio = new Audio(referenceSpeechAudioUrl(artifact.id));
    activeAudio = audio;
    audio.addEventListener("playing", () => {
      if (generation === requestGeneration) {
        publish({ status: "playing", requestKey });
      }
    });
    audio.addEventListener("ended", () => {
      if (generation === requestGeneration) {
        activeAudio = undefined;
        publish({ status: "idle" });
      }
    });
    audio.addEventListener("error", () => {
      if (generation === requestGeneration) {
        activeAudio = undefined;
        publish({
          status: "error",
          requestKey,
          error: "The generated reference WAV could not be played.",
        });
      }
    });
    await audio.play();
  } catch (error) {
    if (generation !== requestGeneration) return;
    publish({
      status: "error",
      requestKey,
      error:
        error instanceof Error
          ? error.message
          : "Reference speech is unavailable.",
    });
    throw error;
  }
}

export function stopReferenceSpeech(): void {
  generation += 1;
  activeArtifactID = undefined;
  if (activeAudio) {
    activeAudio.pause();
    activeAudio.src = "";
    activeAudio = undefined;
  }
  if (getHostConfig()?.voiceTransport === "native") {
    postToHost(INTERACTION_HANDLER, { t: "referenceAudioStop" });
  }
  publish({ status: "idle" });
}
