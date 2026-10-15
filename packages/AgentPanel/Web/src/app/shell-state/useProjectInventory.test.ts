// The Sessions list through a dropped inventory stream. A sidecar restart drops it every time and
// it is back within seconds, so the list it last sent stays on screen and the hook says it is
// reconnecting; only a stream that never delivered reports an error.

import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { ProjectSummary } from "@agentdesk/agent-feed-wire";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import { useProjectInventory } from "@/app/shell-state/useProjectInventory";

const PROJECT = {
  projectPath: "/repo/agent-desk", displayName: "agent-desk", sourceCounts: { claude: 1 }, sessionCount: 1, lastEventAt: 1,
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
