// The Search section's state: the query, its options, and the answer the sidecar gave.
//
// Held by the IDE surface rather than by the section, so switching to the Explorer and back finds
// the results where they were left -- which is how a reader works through them, one file at a
// time -- and dropped when the workspace changes, because they name another project's files.

import { useCallback, useState } from "react";
import type { WorkspaceSearchOptions, WorkspaceSearchResult } from "@agentdesk/agent-feed-wire";
import { WorkspaceRequestError, type WorkspaceIdeClient } from "@/features/workspace-ide/workspaceIdeClient";
import { useTimeout } from "@/hooks/useInterval";
import { sourceKey, usePanelQuery } from "@/query/panelQuery";

/** VS Code's `search.searchOnTypeDebouncePeriod`: a search starts once typing pauses this long. */
export const SEARCH_DEBOUNCE_MS = 300;

export interface ContentSearch {
  query: string;
  options: WorkspaceSearchOptions;
  /** The globs as typed, comma-separated, which is what the two fields hold. */
  include: string;
  exclude: string;
  result: WorkspaceSearchResult | null;
  searching: boolean;
  error: string | null;
  setQuery(query: string): void;
  toggle(option: "matchCase" | "wholeWord" | "regex"): void;
  setInclude(value: string): void;
  setExclude(value: string): void;
  /** Search now rather than after the pause: what Enter in the field does. */
  runNow(): void;
}

function globs(value: string): string[] {
  return value
    .split(",")
    .map((glob) => glob.trim())
    .filter(Boolean);
}

export function useContentSearch(client: WorkspaceIdeClient, workspaceId: string | null): ContentSearch {
  const [query, setQuery] = useState("");
  const [flags, setFlags] = useState({ matchCase: false, wholeWord: false, regex: false });
  const [include, setInclude] = useState("");
  const [exclude, setExclude] = useState("");
  const options: WorkspaceSearchOptions = {
    ...flags,
    include: globs(include),
    exclude: globs(exclude),
  };
  // A string key, so a change to an option is a change and a rebuilt object is not.
  const key = JSON.stringify([workspaceId, query, flags, include, exclude]);

  // What the search runs on: the inputs once typing has paused, or at once after Enter. `run` is
  // bumped by Enter, so pressing it again on the same query searches again.
  const [settled, setSettled] = useState({ key, run: 0, workspaceId, query, options });
  useTimeout(
    () => setSettled((current) => (current.key === key ? current : { ...current, key, workspaceId, query, options })),
    SEARCH_DEBOUNCE_MS,
    key,
  );
  const runNow = () => setSettled((current) => ({ key, run: current.run + 1, workspaceId, query, options }));

  // An empty field or another workspace shows nothing at once, without waiting for the pause.
  const active =
    workspaceId !== null && workspaceId !== "" && query.trim() !== "" && settled.workspaceId === workspaceId;
  const search = usePanelQuery({
    queryKey: ["workspace-search", sourceKey(client), settled.key, settled.run],
    // The sidecar hands the request's signal to `rg`, and a query whose key moves on aborts the
    // one before it, so a search typed past is a process killed rather than one left running.
    queryFn: ({ signal }) => client.search(settled.workspaceId!, settled.query, settled.options, signal),
    enabled: Boolean(settled.workspaceId) && settled.query.trim() !== "",
    placeholderData: (previous) => previous,
  });

  return {
    query,
    options,
    include,
    exclude,
    result: active ? (search.data ?? null) : null,
    searching: active && search.isFetching,
    error:
      active && search.error
        ? search.error instanceof WorkspaceRequestError
          ? search.error.message
          : "The search could not run."
        : null,
    setQuery,
    toggle: useCallback((option) => setFlags((current) => ({ ...current, [option]: !current[option] })), []),
    setInclude,
    setExclude,
    runNow,
  };
}
