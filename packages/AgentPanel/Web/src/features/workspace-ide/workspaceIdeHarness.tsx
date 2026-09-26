// The IDE mounted over a fake transport, which is the seam every test of this surface drives it
// through: everything above it is the code under test, and everything below is HTTP.
//
// Shared rather than copied because two files now mount the same surface -- this one's tests and
// the history popup's -- and a fixture that drifted between them would have the two files
// disagreeing about what a workspace is.

import { act, render, waitFor } from "@testing-library/react";
import { expect } from "vitest";
import type {
  WorkspaceGitStatus,
  WorkspaceSharedState,
  WorkspaceSummary,
  WorkspaceTreeNode,
} from "@agentdesk/agent-feed-wire";
import { FakeHttpTransport } from "@/features/activity-feed/transport/FakeHttpTransport";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import { WorkspaceIdeSurface } from "@/features/workspace-ide/WorkspaceIdeSurface";

export const WORKSPACE: WorkspaceSummary = { id: "w-1", name: "Project", root: "/projects/thing" };

export const TREE: WorkspaceTreeNode[] = [
  {
    name: "src",
    path: "src",
    isDirectory: true,
    expanded: false,
    gitStatus: "M",
    children: [],
  },
  {
    name: "README.md",
    path: "README.md",
    isDirectory: false,
    expanded: false,
    gitStatus: null,
    children: [],
  },
];

export const CLEAN_STATE: WorkspaceSharedState = {
  workspaceId: "w-1",
  revision: 0,
  orderedOpenPaths: [],
  expandedDirectoryPaths: [],
};

export const GIT: WorkspaceGitStatus = {
  workspaceId: "w-1",
  branch: "main",
  entries: [{ relativePath: "src/main.ts", indexStatus: null, workTreeStatus: "M" }],
};

/** The feed is the terminal's, and every file that mounts this surface mocks the terminal away. */
export const feed = {} as SidecarDataSource;

export function transportWith(workspaces: WorkspaceSummary[]): FakeHttpTransport {
  const transport = new FakeHttpTransport();
  transport.responses.set("GET /api/workspaces", {
    status: 200,
    body: JSON.stringify({ workspaces }),
  });
  return transport;
}

/** The surface mounted on one workspace, with the tree and the git status already delivered. */
export async function mountWorkspaceIde(): Promise<FakeHttpTransport> {
  const transport = transportWith([WORKSPACE]);
  render(<WorkspaceIdeSurface transport={transport} feed={feed} />);
  await waitFor(
    () => expect(transport.subscriptions.length).toBeGreaterThan(0),
    // Generous on purpose: this gates every test that uses it, and the default second is not
    // enough when the whole suite is running. What it waits for is a promise chain, not a duration.
    { timeout: 10_000 },
  );
  act(() => {
    transport.deliver("/api/workspaces/w-1/stream", { type: "sharedState", state: CLEAN_STATE });
    transport.deliver("/api/workspaces/w-1/stream", { type: "tree", workspaceId: "w-1", tree: TREE });
    transport.deliver("/api/workspaces/w-1/stream", { type: "git", status: GIT });
  });
  return transport;
}
