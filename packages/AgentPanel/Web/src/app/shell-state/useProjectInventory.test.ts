// The Sessions list through a dropped inventory stream. A sidecar restart drops it every time and
// it is back within seconds, so the list it last sent stays on screen and the hook says it is
// reconnecting; only a stream that never delivered reports an error.

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { ProjectSummary } from "@agentdesk/agent-feed-wire";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import { SESSION_SEARCH_PAUSE_MS, useProjectInventory } from "@/app/shell-state/useProjectInventory";

const PROJECT = {
  projectPath: "/repo/agent-desk",
  displayName: "agent-desk",
  sourceCounts: { claude: 1 },
  sessionCount: 1,
  lastEventAt: 1,
} as ProjectSummary;

/** A feed whose newest inventory subscription the test drives by hand. */
function feed() {
  const stream: { projects?: (projects: ProjectSummary[]) => void; fail?: (reason: string) => void } = {};
  const source = {
    subscribeInventory(
      _paths: readonly string[],
      handlers: { onProjects: (projects: ProjectSummary[]) => void },
      onError: (reason: string) => void,
    ) {
      stream.projects = handlers.onProjects;
      stream.fail = onError;
      return () => {};
    },
  } as unknown as SidecarDataSource;
  return { source, stream };
}

const NO_PATHS: string[] = [];

describe("useProjectInventory", () => {
  it("keeps the list through a dropped stream and says it is reconnecting until the next answer", () => {
    const { source, stream } = feed();
    const { result } = renderHook(() => useProjectInventory(source, NO_PATHS, undefined));

    act(() => stream.projects?.([PROJECT]));
    act(() => stream.fail?.("stream failed"));

    expect(result.current.projects).toEqual([PROJECT]);
    expect(result.current.reconnecting).toBe(true);
    expect(result.current.layerError).toBeNull();
    expect(result.current.loadingLayer).toBe(false);

    act(() => stream.projects?.([PROJECT]));
    expect(result.current.reconnecting).toBe(false);
  });

  it("reports an error for a stream that never delivered", () => {
    const { source, stream } = feed();
    const { result } = renderHook(() => useProjectInventory(source, NO_PATHS, undefined));

    act(() => stream.fail?.("stream failed"));

    expect(result.current.layerError).toBe("stream failed");
    expect(result.current.reconnecting).toBe(false);
  });
});

/** A feed that records what each inventory subscription asked for: `[recent, query]`. */
function recordingFeed() {
  const asked: Array<[number | undefined, string]> = [];
  const source = {
    subscribeInventory(
      _paths: readonly string[],
      _handlers: unknown,
      _onError: unknown,
      recent?: number,
      _reviews?: number,
      query = "",
    ) {
      asked.push([recent, query]);
      return () => {};
    },
  } as unknown as SidecarDataSource;
  return { source, asked };
}

describe("the title search on the inventory stream", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("asks once typing pauses, not per letter, and drops the search at once when cleared", () => {
    vi.useFakeTimers();
    const { source, asked } = recordingFeed();
    const { result } = renderHook(() => useProjectInventory(source, NO_PATHS, undefined, true, true));
    expect(asked).toEqual([[30, ""]]);

    act(() => result.current.changeRecentQuery("lo"));
    act(() => result.current.changeRecentQuery("login "));
    expect(asked).toHaveLength(1);
    act(() => vi.advanceTimersByTime(SESSION_SEARCH_PAUSE_MS));
    // Trimmed, so the space a reader types before the next word does not reopen the stream.
    expect(asked.at(-1)).toEqual([30, "login"]);
    expect(result.current.searching).toBe(true);

    act(() => result.current.changeRecentQuery(""));
    expect(asked.at(-1)).toEqual([30, ""]);
    expect(result.current.searching).toBe(false);
  });

  it("carries the flat list while grouped only for as long as a search is showing", () => {
    vi.useFakeTimers();
    const { source, asked } = recordingFeed();
    const { result, rerender } = renderHook(
      ({ searchable }) => useProjectInventory(source, NO_PATHS, undefined, false, searchable),
      { initialProps: { searchable: true } },
    );
    expect(asked).toEqual([[undefined, ""]]);

    act(() => result.current.changeRecentQuery("login"));
    act(() => vi.advanceTimersByTime(SESSION_SEARCH_PAUSE_MS));
    expect(asked.at(-1)).toEqual([30, "login"]);

    // Off the Sessions view, the search is kept in the field but asks the stream for nothing.
    rerender({ searchable: false });
    expect(asked.at(-1)).toEqual([undefined, ""]);
    expect(result.current.recentQuery).toBe("login");
  });
});
