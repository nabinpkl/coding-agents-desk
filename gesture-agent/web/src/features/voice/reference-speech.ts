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
import type {
  ReferenceSpeechArtifact,
  ReferenceSpeechScopeRequest,
} from "@/lib/wire";

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

interface ReferenceSpeechRequest {
  passageID: string;
  passageRevision: number;
  scope: ReferenceSpeechScopeRequest;
  preferences: ReferenceSpeechPreferences;
}

interface PreparedReferenceAudio {
  readonly buffer: AudioBuffer;
  readonly bytes: number;
}

const DECODED_REFERENCE_AUDIO_CACHE_MAX_BYTES = 16 * 1024 * 1024;

let state: ReferenceSpeechPlaybackState = { status: "idle" };
const listeners = new Set<() => void>();
let nativeDeliveryInstalled = false;

function publish(next: ReferenceSpeechPlaybackState): void {
  state = next;
  for (const listener of listeners) listener();
}

function playbackKey(request: ReferenceSpeechRequest): string {
  const { passageID, passageRevision, scope } = request;
  const scopeKey = scope.kind === "passage" ? "passage" : `word:${scope.index ?? -1}`;
  return [passageID, passageRevision, scopeKey].join(":");
}

function artifactCacheKey(request: ReferenceSpeechRequest): string {
  return [
    playbackKey(request),
    request.preferences.voiceIdentifier,
    request.preferences.speed.toFixed(2),
  ].join(":");
}

/**
 * Owns reference-audio lifecycle behind a small playback interface.
 *
 * The host cache retains generated WAVs across launches. This player retains
 * decoded buffers for the current webview session, so a word already heard is
 * ready to restart without another request, fetch, or decode.
 */
class ReferenceAudioPlayer {
  private generation = 0;
  private audioContext: AudioContext | undefined;
  private activeSource: AudioBufferSourceNode | undefined;
  private activeNativeArtifactID: string | undefined;
  private readonly artifacts = new Map<string, ReferenceSpeechArtifact>();
  private readonly resolvingArtifacts = new Map<
    string,
    Promise<ReferenceSpeechArtifact>
  >();
  private readonly preparedAudio = new Map<string, PreparedReferenceAudio>();
  private readonly preparingAudio = new Map<string, Promise<PreparedReferenceAudio>>();
  private preparedBytes = 0;

  play(request: ReferenceSpeechRequest): Promise<void> {
    const intent = ++this.generation;
    const displayKey = playbackKey(request);
    const cacheKey = artifactCacheKey(request);
    const nativePlayback = getHostConfig()?.voiceTransport === "native";

    // A tap is an interruption command. Never leave an older word audible
    // while a later click is resolving.
    this.interruptPlayback();
    publish({ status: "preparing", requestKey: displayKey });

    if (!nativePlayback) {
      this.resumeAudioContextForGesture();
    }

    const artifact = this.artifacts.get(cacheKey);
    if (artifact) {
      return this.playResolvedArtifact(artifact, intent, displayKey, nativePlayback);
    }

    return this.resolveArtifact(cacheKey, request).then(
      (resolved) => this.playResolvedArtifact(resolved, intent, displayKey, nativePlayback),
      (error: unknown) => this.handleError(intent, displayKey, error),
    );
  }

  stop(): void {
    this.generation += 1;
    this.interruptPlayback();
    publish({ status: "idle" });
  }

  handleNativeEvent(event: NativeReferenceAudioEvent): void {
    if (
      !this.activeNativeArtifactID ||
      !event.artifactID ||
      event.artifactID !== this.activeNativeArtifactID
    ) {
      return;
    }
    if (event.status === "preparing") return;
    if (event.status === "playing") {
      publish({ ...state, status: "playing", error: undefined });
      return;
    }
    this.activeNativeArtifactID = undefined;
    if (event.status === "failed") {
      publish({
        status: "error",
        requestKey: state.requestKey,
        error: event.error ?? "Reference audio playback failed.",
      });
      return;
    }
    publish({ status: "idle" });
  }

  resetForTesting(): void {
    this.stop();
    this.artifacts.clear();
    this.resolvingArtifacts.clear();
    this.preparedAudio.clear();
    this.preparingAudio.clear();
    this.preparedBytes = 0;
    this.audioContext = undefined;
  }

  private resolveArtifact(
    key: string,
    request: ReferenceSpeechRequest,
  ): Promise<ReferenceSpeechArtifact> {
    const pending = this.resolvingArtifacts.get(key);
    if (pending) return pending;

    const resolution = createReferenceSpeechArtifact({
      passageId: request.passageID,
      passageRevision: request.passageRevision,
      scope: request.scope,
      voiceIdentifier: request.preferences.voiceIdentifier,
      speed: request.preferences.speed,
    }).then((artifact) => {
      this.artifacts.set(key, artifact);
      return artifact;
    });
    this.resolvingArtifacts.set(key, resolution);
    void resolution.then(
      () => this.resolvingArtifacts.delete(key),
      () => this.resolvingArtifacts.delete(key),
    );
    return resolution;
  }

  private playResolvedArtifact(
    artifact: ReferenceSpeechArtifact,
    intent: number,
    key: string,
    nativePlayback: boolean,
  ): Promise<void> {
    if (intent !== this.generation) return Promise.resolve();
    if (nativePlayback) {
      this.activeNativeArtifactID = artifact.id;
      postToHost(INTERACTION_HANDLER, {
        t: "referenceAudioPlay",
        artifactID: artifact.id,
        audioHash: artifact.audioHash,
      });
      return Promise.resolve();
    }

    const prepared = this.takePreparedAudio(artifact.id);
    if (prepared) {
      this.startPreparedAudio(prepared.buffer, intent, key);
      return Promise.resolve();
    }
    return this.prepareAudio(artifact).then(
      (next) => {
        if (intent === this.generation) {
          this.startPreparedAudio(next.buffer, intent, key);
        }
      },
      (error: unknown) => this.handleError(intent, key, error),
    );
  }

  private prepareAudio(
    artifact: ReferenceSpeechArtifact,
  ): Promise<PreparedReferenceAudio> {
    const pending = this.preparingAudio.get(artifact.id);
    if (pending) return pending;

    const preparation = (async () => {
      const response = await fetch(referenceSpeechAudioUrl(artifact.id));
      if (!response.ok) {
        throw new Error(`Reference audio request failed (${response.status}).`);
      }
      const encoded = await response.arrayBuffer();
      const buffer = await this.audioContextForPlayback().decodeAudioData(encoded);
      const prepared = {
        buffer,
        bytes:
          buffer.length * buffer.numberOfChannels * Float32Array.BYTES_PER_ELEMENT,
      };
      this.rememberPreparedAudio(artifact.id, prepared);
      return prepared;
    })();
    this.preparingAudio.set(artifact.id, preparation);
    void preparation.then(
      () => this.preparingAudio.delete(artifact.id),
      () => this.preparingAudio.delete(artifact.id),
    );
    return preparation;
  }

  private startPreparedAudio(
    buffer: AudioBuffer,
    intent: number,
    key: string,
  ): void {
    const context = this.audioContextForPlayback();
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    source.onended = () => {
      if (this.activeSource !== source) return;
      this.activeSource = undefined;
      if (intent === this.generation) publish({ status: "idle" });
    };
    this.activeSource = source;
    source.start(0);
    publish({ status: "playing", requestKey: key });
  }

  private interruptPlayback(): void {
    const source = this.activeSource;
    this.activeSource = undefined;
    if (source) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // A source can finish between assignment and interruption.
      }
      source.disconnect();
    }
    if (this.activeNativeArtifactID) {
      this.activeNativeArtifactID = undefined;
      postToHost(INTERACTION_HANDLER, { t: "referenceAudioStop" });
    }
  }

  private audioContextForPlayback(): AudioContext {
    if (this.audioContext) return this.audioContext;
    if (typeof AudioContext === "undefined") {
      throw new Error("Reference audio is unavailable in this browser.");
    }
    this.audioContext = new AudioContext();
    return this.audioContext;
  }

  private resumeAudioContextForGesture(): void {
    try {
      void this.audioContextForPlayback().resume().catch(() => undefined);
    } catch {
      // The later preparation/start path reports the actionable failure.
    }
  }

  private takePreparedAudio(artifactID: string): PreparedReferenceAudio | undefined {
    const prepared = this.preparedAudio.get(artifactID);
    if (!prepared) return undefined;
    this.preparedAudio.delete(artifactID);
    this.preparedAudio.set(artifactID, prepared);
    return prepared;
  }

  private rememberPreparedAudio(
    artifactID: string,
    prepared: PreparedReferenceAudio,
  ): void {
    const previous = this.preparedAudio.get(artifactID);
    if (previous) {
      this.preparedBytes -= previous.bytes;
      this.preparedAudio.delete(artifactID);
    }
    this.preparedAudio.set(artifactID, prepared);
    this.preparedBytes += prepared.bytes;
    while (
      this.preparedBytes > DECODED_REFERENCE_AUDIO_CACHE_MAX_BYTES &&
      this.preparedAudio.size > 1
    ) {
      const oldest = this.preparedAudio.entries().next().value;
      if (!oldest) break;
      const [oldestID, oldestPrepared] = oldest;
      this.preparedAudio.delete(oldestID);
      this.preparedBytes -= oldestPrepared.bytes;
    }
  }

  private handleError(intent: number, key: string, error: unknown): void {
    if (intent !== this.generation) return;
    publish({
      status: "error",
      requestKey: key,
      error:
        error instanceof Error
          ? error.message
          : "Reference speech is unavailable.",
    });
  }
}

const player = new ReferenceAudioPlayer();

function ensureNativeDelivery(): void {
  if (nativeDeliveryInstalled || typeof window === "undefined") return;
  nativeDeliveryInstalled = true;
  subscribeInteractionDelivery<NativeReferenceAudioEvent>(
    "referenceAudioState",
    (event) => player.handleNativeEvent(event),
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

export function speakReference(
  passageID: string,
  passageRevision: number,
  scope: ReferenceSpeechScopeRequest,
  preferences: ReferenceSpeechPreferences,
): Promise<void> {
  ensureNativeDelivery();
  return player.play({ passageID, passageRevision, scope, preferences });
}

export function stopReferenceSpeech(): void {
  player.stop();
}

/** Test-only reset for the module-level playback owner. */
export function resetReferenceSpeechForTesting(): void {
  player.resetForTesting();
}
