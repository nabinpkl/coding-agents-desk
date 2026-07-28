/**
 * Typed fetch wrappers for the FastAPI REST endpoints. Thin transport only: no
 * feature logic, no caching. Callers own ret/react-query orchestration. Every
 * wrapper fails loud on a non-2xx response.
 */

import { API_BASE } from "@/lib/config";
import { getHostConfig } from "@/lib/host-bridge";
import { postNativeVoice, subscribeNativeVoice } from "@/lib/native-voice";
import type {
  AnalyzePronunciationRequest,
  AnalyzeSignalsRequest,
  PronunciationComparison,
  Recording,
  RecordingListResponse,
  CreateReferenceSpeechArtifactRequest,
  ReferenceSpeechArtifact,
  ReferenceSpeechState,
  SaveRecordingRequest,
  SignalAnalysis,
} from "@/lib/wire";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly statusText: string,
    readonly body: string,
  ) {
    super(`API ${status} ${statusText}: ${body}`);
    this.name = "ApiError";
  }
}

/**
 * REST base. Embedded, the native host injects the voice sidecar's loopback
 * origin (there is no Next rewrite under the custom scheme); in a plain browser
 * we fall back to the same-origin `/api` rewrite. Resolved per call so a config
 * injected after module load still takes effect.
 */
function apiBase(): string {
  return getHostConfig()?.apiBaseUrl ?? API_BASE;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  if (getHostConfig()?.voiceTransport === "native") {
    const response = await nativeRequest(
      path,
      init,
      path === "/reference-speech/artifacts" ? 180_000 : 30_000,
    );
    if (response.status < 200 || response.status >= 300) {
      throw new ApiError(response.status, "Native proxy error",
        new TextDecoder().decode(response.body));
    }
    return JSON.parse(new TextDecoder().decode(response.body)) as T;
  }
  const response = await fetch(`${apiBase()}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  if (!response.ok) {
    throw new ApiError(
      response.status,
      response.statusText,
      await response.text(),
    );
  }
  return (await response.json()) as T;
}

async function nativeRequest(
  path: string,
  init?: RequestInit,
  timeoutMilliseconds = 10_000,
): Promise<{
  status: number;
  contentType?: string;
  body: Uint8Array;
}> {
  const requestID = crypto.randomUUID();
  const bodyText = typeof init?.body === "string" ? init.body : undefined;
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let nextSequence = 0;
    const timeout = window.setTimeout(() => {
      unsubscribe();
      reject(new Error("Mac voice request timed out"));
    }, timeoutMilliseconds);
    const unsubscribe = subscribeNativeVoice((message) => {
      if (message.t === "rest" && message.r?.requestID === requestID) {
        if (message.r.sequence !== nextSequence) {
          window.clearTimeout(timeout);
          unsubscribe();
          reject(new Error("Mac voice response arrived out of order"));
          return;
        }
        nextSequence += 1;
        const binary = atob(message.r.body);
        chunks.push(Uint8Array.from(binary, (value) => value.charCodeAt(0)));
        if (message.r.isFinal) {
          window.clearTimeout(timeout);
          unsubscribe();
          const length = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
          const body = new Uint8Array(length);
          let offset = 0;
          for (const chunk of chunks) {
            body.set(chunk, offset);
            offset += chunk.byteLength;
          }
          resolve({
            status: message.r.status,
            contentType: message.r.contentType,
            body,
          });
        }
      } else if (message.t === "error" && message.rid === requestID) {
        window.clearTimeout(timeout);
        unsubscribe();
        reject(new Error(message.m ?? "Mac voice request failed"));
      }
    });
    postNativeVoice({
      t: "voiceREST",
      requestID,
      method: init?.method ?? "GET",
      path,
      ...(bodyText ? { bodyBase64: btoa(bodyText) } : {}),
    });
  });
}

function postJson<T>(path: string, payload: unknown): Promise<T> {
  return request<T>(path, { method: "POST", body: JSON.stringify(payload) });
}

export async function listRecordings(): Promise<Recording[]> {
  // GET /recordings returns the wire RecordingListResponse ({ recordings: [...] });
  // unwrap here so callers keep a bare Recording[] to iterate.
  const response = await request<RecordingListResponse>("/recordings");
  return response.recordings;
}

export function getRecording(id: string): Promise<Recording> {
  return request<Recording>(`/recordings/${encodeURIComponent(id)}`);
}

/**
 * Playable URL for a recording's saved audio. Returned as a URL rather than a
 * blob so an <audio> element can stream and seek it directly; every other
 * endpoint hands back JSON, this one is the wav itself.
 */
export function recordingAudioUrl(id: string): string {
  return `${apiBase()}/recordings/${encodeURIComponent(id)}/audio`;
}

export async function loadRecordingAudioURL(id: string): Promise<string> {
  if (getHostConfig()?.voiceTransport !== "native") {
    return recordingAudioUrl(id);
  }
  const response = await nativeRequest(
    `/recordings/${encodeURIComponent(id)}/audio`,
  );
  if (response.status !== 200) {
    throw new ApiError(response.status, "Native proxy error", "audio unavailable");
  }
  const copy = new Uint8Array(response.body.byteLength);
  copy.set(response.body);
  return URL.createObjectURL(new Blob([copy.buffer], { type: "audio/wav" }));
}

/** Delete a recording and its audio. Answers 204, so there is no body to read. */
export async function deleteRecording(id: string): Promise<void> {
  if (getHostConfig()?.voiceTransport === "native") {
    const response = await nativeRequest(
      `/recordings/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
    if (response.status < 200 || response.status >= 300) {
      throw new ApiError(response.status, "Native proxy error", "delete failed");
    }
    return;
  }
  const response = await fetch(
    `${apiBase()}/recordings/${encodeURIComponent(id)}`,
    { method: "DELETE" },
  );
  if (!response.ok) {
    throw new ApiError(
      response.status,
      response.statusText,
      await response.text(),
    );
  }
}

export function reanalyzeRecording(id: string): Promise<Recording> {
  return postJson<Recording>(
    `/recordings/${encodeURIComponent(id)}/reanalyze`,
    {},
  );
}

export function getReferenceSpeechState(): Promise<ReferenceSpeechState> {
  return request<ReferenceSpeechState>("/reference-speech/state");
}

export function createReferenceSpeechArtifact(
  payload: CreateReferenceSpeechArtifactRequest,
): Promise<ReferenceSpeechArtifact> {
  return postJson<ReferenceSpeechArtifact>(
    "/reference-speech/artifacts",
    payload,
  );
}

export function referenceSpeechAudioUrl(artifactID: string): string {
  return `${apiBase()}/reference-speech/artifacts/${encodeURIComponent(artifactID)}/audio`;
}

export function saveRecording(
  payload: SaveRecordingRequest,
): Promise<Recording> {
  return postJson<Recording>("/recordings", payload);
}

export function analyzeSignals(
  payload: AnalyzeSignalsRequest,
): Promise<SignalAnalysis> {
  return postJson<SignalAnalysis>("/analyze/signals", payload);
}

export function analyzePronunciation(
  payload: AnalyzePronunciationRequest,
): Promise<PronunciationComparison> {
  return postJson<PronunciationComparison>("/analyze/pronunciation", payload);
}
