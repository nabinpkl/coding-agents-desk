// Data the panel reads once and shows: a config, a list, a file, a commit. Each read is a query in
// one cache, rather than an effect per component that fetches, guards against a late answer, and
// keeps its own copy (ADR-0146).
//
// Streams are not here. A sidecar stream never ends, and a query is "fetching" until its function
// returns, so a stream lives in a store keyed on its data source (`createSourceStore`) instead.
//
// One client for the page, passed to every hook rather than provided through context, so a
// component that reads a query renders the same in a test as on the page with nothing wrapped
// around it. Every key starts with the identity of the object the query reads from (`sourceKey`):
// a hot swap of the data source builds a new object, and a key without it would keep serving what
// the replaced one answered.

import {
  QueryClient,
  useQuery,
  type DefaultError,
  type QueryKey,
  type UseQueryOptions,
  type UseQueryResult,
} from "@tanstack/react-query";

export const panelQueryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Each read was tried once before this cache existed, and a failure showed at once. A retry
      // would hold the error back for seconds while the reader looked at a spinner.
      retry: false,
      // A phone switches tabs constantly, and every switch would refetch every list on screen.
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    },
  },
});

/** `useQuery` against the page's one client. */
export function usePanelQuery<TData, TKey extends QueryKey = QueryKey>(
  options: UseQueryOptions<TData, DefaultError, TData, TKey>,
): UseQueryResult<TData, DefaultError> {
  return useQuery(options, panelQueryClient);
}

const ids = new WeakMap<object, number>();
let lastId = 0;

/**
 * A number naming this object for as long as it lives, for a query key. Two objects never share
 * one, so a data source rebuilt by a hot swap reads afresh instead of finding the old one's answer.
 */
export function sourceKey(source: object): number {
  let id = ids.get(source);
  if (id === undefined) {
    id = ++lastId;
    ids.set(source, id);
  }
  return id;
}

/** The message a failed query shows, whatever was thrown. */
export function queryFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
