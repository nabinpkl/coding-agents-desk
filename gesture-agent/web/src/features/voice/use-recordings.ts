/**
 * Truth side of the voice feature: the list of persisted recordings, owned by
 * the TanStack Query cache. `RECORDINGS_QUERY_KEY` is the single handle other
 * code uses to invalidate this cache (notably on `sessionComplete`, when a
 * freshly persisted recording should appear).
 */

"use client";

import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { listRecordings } from "@/lib/api";
import type { Recording } from "@/lib/wire";

export const RECORDINGS_QUERY_KEY = ["recordings"] as const;

export function useRecordings(): UseQueryResult<Recording[]> {
  return useQuery({
    queryKey: RECORDINGS_QUERY_KEY,
    queryFn: listRecordings,
  });
}
