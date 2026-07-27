/**
 * Truth side of the voice feature: the list of persisted recordings, owned by
 * the TanStack Query cache. `RECORDINGS_QUERY_KEY` is the single handle other
 * code uses to invalidate this cache (notably on `sessionComplete`, when a
 * freshly persisted recording should appear).
 */

"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";

import { deleteRecording, listRecordings, reanalyzeRecording } from "@/lib/api";
import type { Recording } from "@/lib/wire";

export const RECORDINGS_QUERY_KEY = ["recordings"] as const;

export function useRecordings(): UseQueryResult<Recording[]> {
  return useQuery({
    queryKey: RECORDINGS_QUERY_KEY,
    queryFn: listRecordings,
    // The library is host-owned and can change from the other paired surface.
    // A short loopback poll also discovers an interrupted iPhone capture after
    // transport recovery, when no sessionComplete can reach the disconnected UI.
    refetchInterval: 5_000,
  });
}

/**
 * Delete one recording. The server owns the list, so this refetches rather than
 * editing the cache by hand — a delete that failed server-side must not leave
 * the row missing from the view.
 */
export function useDeleteRecording(): UseMutationResult<void, Error, string> {
  const queryClient = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: deleteRecording,
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: RECORDINGS_QUERY_KEY }),
  });
}

export function useReanalyzeRecording(): UseMutationResult<Recording, Error, string> {
  const queryClient = useQueryClient();
  return useMutation<Recording, Error, string>({
    mutationFn: reanalyzeRecording,
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: RECORDINGS_QUERY_KEY }),
  });
}
