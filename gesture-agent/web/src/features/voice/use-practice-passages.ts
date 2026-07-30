/**
 * Host-owned practice-passage truth and mutations.
 */

"use client";

import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
} from "@tanstack/react-query";

import {
  ApiError,
  deletePracticePassage,
  deletePracticePassageAttempt,
  listPracticePassageAttempts,
  listPracticePassages,
  reanalyzeRecording,
  updatePracticePassageBaseline,
  updatePracticePassageText,
} from "@/lib/api";
import type {
  PracticePassage,
  PracticePassageAttemptsResponse,
  PracticePassageListResponse,
  Recording,
  UpdatePracticePassageBaselineRequest,
  UpdatePracticePassageTextRequest,
} from "@/lib/wire";

export const PRACTICE_PASSAGES_QUERY_KEY = ["practice-passages"] as const;
export const RECORDINGS_QUERY_KEY = ["recordings"] as const;

function cachePassage(
  queryClient: QueryClient,
  updated: PracticePassage,
): void {
  queryClient.setQueryData<InfiniteData<PracticePassageListResponse>>(
    PRACTICE_PASSAGES_QUERY_KEY,
    (existing) =>
      existing
        ? {
            ...existing,
            pages: existing.pages.map((page) => ({
              ...page,
              passages: page.passages.map((passage) =>
                passage.id === updated.id ? updated : passage,
              ),
            })),
          }
        : existing,
  );
  queryClient.removeQueries({
    queryKey: [...PRACTICE_PASSAGES_QUERY_KEY, updated.id],
  });
}

function removePassageFromCache(
  queryClient: QueryClient,
  passageID: string,
): void {
  queryClient.setQueryData<InfiniteData<PracticePassageListResponse>>(
    PRACTICE_PASSAGES_QUERY_KEY,
    (existing) =>
      existing
        ? {
            ...existing,
            pages: existing.pages.map((page) => ({
              ...page,
              passages: page.passages.filter(
                (passage) => passage.id !== passageID,
              ),
            })),
          }
        : existing,
  );
  queryClient.removeQueries({
    queryKey: [...PRACTICE_PASSAGES_QUERY_KEY, passageID],
  });
}

function cacheReanalyzedAttempt(
  queryClient: QueryClient,
  updated: Recording,
): void {
  queryClient.setQueriesData<
    InfiniteData<PracticePassageAttemptsResponse>
  >(
    {
      queryKey: [
        ...PRACTICE_PASSAGES_QUERY_KEY,
        updated.passageId,
        updated.passageRevision,
      ],
    },
    (existing) =>
      existing
        ? {
            ...existing,
            pages: existing.pages.map((page) => ({
              ...page,
              attempts: page.attempts.map((attempt) =>
                attempt.id === updated.id ? updated : attempt,
              ),
            })),
          }
        : existing,
  );
}

export function invalidateVoiceTruth(queryClient: QueryClient): Promise<void> {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: PRACTICE_PASSAGES_QUERY_KEY }),
    queryClient.invalidateQueries({ queryKey: RECORDINGS_QUERY_KEY }),
  ]).then(() => undefined);
}

export function usePracticePassages() {
  return useInfiniteQuery<PracticePassageListResponse>({
    queryKey: PRACTICE_PASSAGES_QUERY_KEY,
    queryFn: ({ pageParam }) =>
      listPracticePassages({
        cursor: typeof pageParam === "string" ? pageParam : undefined,
        limit: 50,
      }),
    initialPageParam: undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    refetchInterval: 5_000,
  });
}

export function usePracticePassageAttempts(
  passageID: string,
  passageRevision: number,
  enabled: boolean,
) {
  return useInfiniteQuery<PracticePassageAttemptsResponse>({
    queryKey: [
      ...PRACTICE_PASSAGES_QUERY_KEY,
      passageID,
      passageRevision,
      "attempts",
    ],
    queryFn: async ({ pageParam }) => {
      const response = await listPracticePassageAttempts(passageID, {
        cursor:
          typeof pageParam === "string" ? pageParam : undefined,
        limit: 20,
      });
      if (response.passage.revision !== passageRevision) {
        throw new ApiError(
          409,
          "Practice passage changed",
          "Refresh the passage before displaying attempt derivations.",
        );
      }
      return response;
    },
    initialPageParam: undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled,
    refetchInterval: 5_000,
  });
}

export function useUpdatePracticePassageText() {
  const queryClient = useQueryClient();
  return useMutation<
    PracticePassage,
    Error,
    {
      readonly passageID: string;
      readonly request: UpdatePracticePassageTextRequest;
    }
  >({
    mutationFn: ({ passageID, request }) =>
      updatePracticePassageText(passageID, request),
    onSuccess: (updated) => {
      cachePassage(queryClient, updated);
      return invalidateVoiceTruth(queryClient);
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409) {
        void invalidateVoiceTruth(queryClient);
      }
    },
  });
}

export function useUpdatePracticePassageBaseline() {
  const queryClient = useQueryClient();
  return useMutation<
    PracticePassage,
    Error,
    {
      readonly passageID: string;
      readonly request: UpdatePracticePassageBaselineRequest;
    }
  >({
    mutationFn: ({ passageID, request }) =>
      updatePracticePassageBaseline(passageID, request),
    onSuccess: (updated) => {
      cachePassage(queryClient, updated);
      return invalidateVoiceTruth(queryClient);
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409) {
        void invalidateVoiceTruth(queryClient);
      }
    },
  });
}

export function useDeletePracticePassageAttempt() {
  const queryClient = useQueryClient();
  return useMutation<
    PracticePassage,
    Error,
    {
      readonly passageID: string;
      readonly recordingID: string;
    }
  >({
    mutationFn: ({ passageID, recordingID }) =>
      deletePracticePassageAttempt(passageID, recordingID),
    onSuccess: (updated) => {
      cachePassage(queryClient, updated);
      return invalidateVoiceTruth(queryClient);
    },
  });
}

export function useDeletePracticePassage() {
  const queryClient = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: deletePracticePassage,
    onSuccess: (_, passageID) => {
      removePassageFromCache(queryClient, passageID);
      return invalidateVoiceTruth(queryClient);
    },
  });
}

export function useReanalyzePracticeAttempt() {
  const queryClient = useQueryClient();
  return useMutation<Recording, Error, string>({
    mutationFn: reanalyzeRecording,
    onSuccess: (updated) => {
      cacheReanalyzedAttempt(queryClient, updated);
      return invalidateVoiceTruth(queryClient);
    },
  });
}
