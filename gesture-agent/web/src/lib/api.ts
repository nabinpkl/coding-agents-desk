/**
 * Typed fetch wrappers for the FastAPI REST endpoints. Thin transport only: no
 * feature logic, no caching. Callers own ret/react-query orchestration. Every
 * wrapper fails loud on a non-2xx response.
 */

import { API_BASE } from "@/lib/config";
import { getHostConfig } from "@/lib/host-bridge";
import type {
  AnalyzePronunciationRequest,
  AnalyzeSignalsRequest,
  PronunciationComparison,
  Recording,
  RecordingListResponse,
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

/** Delete a recording and its audio. Answers 204, so there is no body to read. */
export async function deleteRecording(id: string): Promise<void> {
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
