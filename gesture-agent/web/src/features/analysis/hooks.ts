/**
 * TanStack Query hooks for the analysis feature. These own all server-state
 * orchestration; views read from them and never call the api layer directly.
 *
 * Signal analysis is modeled as a query keyed by recording id (idempotent read
 * derived from a saved recording). Pronunciation comparison is a mutation: it
 * takes an explicit user action (pick two recordings, run) and is keyed by the
 * pair the user submitted, so we expose the last result via the mutation state.
 */

import { useMutation, useQuery } from "@tanstack/react-query";

import {
  analyzePronunciation,
  analyzeSignals,
  listRecordings,
} from "@/lib/api";
import type {
  AnalyzePronunciationRequest,
  PronunciationComparison,
  Recording,
  SignalAnalysis,
} from "@/lib/wire";

export const analysisQueryKeys = {
  recordings: ["recordings"] as const,
  signals: (recordingId: string) => ["analyze", "signals", recordingId] as const,
};

export function useRecordings() {
  return useQuery<Recording[]>({
    queryKey: analysisQueryKeys.recordings,
    queryFn: listRecordings,
  });
}

/**
 * Fetch the signal analysis for a single saved recording. Disabled until a
 * recording is selected so switching selections drives the request.
 */
export function useSignalAnalysis(recordingId: string | null) {
  return useQuery<SignalAnalysis>({
    queryKey: analysisQueryKeys.signals(recordingId ?? "none"),
    queryFn: () => analyzeSignals({ recordingId: recordingId as string }),
    enabled: recordingId !== null,
    staleTime: Number.POSITIVE_INFINITY,
  });
}

export function usePronunciationComparison() {
  return useMutation<PronunciationComparison, Error, AnalyzePronunciationRequest>({
    mutationFn: analyzePronunciation,
  });
}
