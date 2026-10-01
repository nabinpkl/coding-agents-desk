// The Search section's state: the query, its options, and the answer the sidecar gave.
//
// Held by the IDE surface rather than by the section, so switching to the Explorer and back finds
// the results where they were left -- which is how a reader works through them, one file at a
// time -- and dropped when the workspace changes, because they name another project's files.

import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkspaceSearchOptions, WorkspaceSearchResult } from "@agentdesk/agent-feed-wire";
import { WorkspaceRequestError, type WorkspaceIdeClient } from "@/features/workspace-ide/workspaceIdeClient";

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
  return value.split(",").map((glob) => glob.trim()).filter(Boolean);
}

export function useContentSearch(client: WorkspaceIdeClient, workspaceId: string | null): ContentSearch {
  const [query, setQuery] = useState("");
  const [flags, setFlags] = useState({ matchCase: false, wholeWord: false, regex: false });
  const [include, setInclude] = useState("");
  const [exclude, setExclude] = useState("");
  const [result, setResult] = useState<WorkspaceSearchResult | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bumped by Enter, so an immediate search is one more change the effect below reacts to.
  const [forced, setForced] = useState(0);
  const lastForced = useRef(forced);

  const options: WorkspaceSearchOptions = {
    ...flags,
    include: globs(include),
    exclude: globs(exclude),
  };
  // A string key, so the effect runs when an option changes and not when the object is rebuilt.
  const key = JSON.stringify([workspaceId, query, flags, include, exclude]);

  useEffect(() => {
    setResult(null);
  }, [workspaceId]);

  useEffect(() => {
    const now = lastForced.current !== forced;
    lastForced.current = forced;
    if (!workspaceId || query.trim() === "") {
      setResult(null);
      setError(null);
      setSearching(false);
      return;
    }
    // Every change aborts the search before it: the sidecar hands the request's signal to `rg`,
    // so a search typed past is a process killed, not one left running for nobody.
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setSearching(true);
      client.search(workspaceId, query, options, controller.signal)
        .then((answer) => {
          setResult(answer);
          setError(null);
        })
        .catch((cause: unknown) => {
          if (controller.signal.aborted) return;
          setError(cause instanceof WorkspaceRequestError ? cause.message : "The search could not run.");
          setResult(null);
        })
        .finally(() => {
          if (!controller.signal.aborted) setSearching(false);
        });
    }, now ? 0 : SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
    // `key` stands for every input; `options` is rebuilt from the same values each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, key, forced]);

  return {
    query,
    options,
    include,
    exclude,
    result,
    searching,
    error,
    setQuery,
    toggle: useCallback((option) => setFlags((current) => ({ ...current, [option]: !current[option] })), []),
    setInclude,
    setExclude,
    runNow: useCallback(() => setForced((count) => count + 1), []),
  };
}
