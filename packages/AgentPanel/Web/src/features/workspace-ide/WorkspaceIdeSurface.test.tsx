// The surface driven through the fake transport, which is the seam the panel's other feature tests
// use: everything above it is the code under test, and everything below is HTTP.

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type {
  WorkspaceGitStatus,
  WorkspaceSharedState,
  WorkspaceSummary,
  WorkspaceTreeNode,
} from "@agentdesk/agent-feed-wire";
import { FakeHttpTransport } from "@/features/activity-feed/transport/FakeHttpTransport";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import { WorkspaceIdeSurface } from "@/features/workspace-ide/WorkspaceIdeSurface";

// The terminal pane is a whole other surface with an xterm inside it; this file is about the IDE.
vi.mock("@/features/terminal/TerminalsSurface", () => ({
  TerminalsSurface: () => <div data-testid="terminals" />,
}));

const WORKSPACE: WorkspaceSummary = { id: "w-1", name: "Project", root: "/projects/thing" };

const TREE: WorkspaceTreeNode[] = [
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

const CLEAN_STATE: WorkspaceSharedState = {
  workspaceId: "w-1",
  revision: 0,
  orderedOpenPaths: [],
  expandedDirectoryPaths: [],
};

const GIT: WorkspaceGitStatus = {
  workspaceId: "w-1",
  branch: "main",
  entries: [{ relativePath: "src/main.ts", indexStatus: null, workTreeStatus: "M" }],
};

const feed = {} as SidecarDataSource;

beforeEach(() => localStorage.clear());

function transportWith(workspaces: WorkspaceSummary[]): FakeHttpTransport {
  const transport = new FakeHttpTransport();
  transport.responses.set("GET /api/workspace/list", {
    status: 200,
    body: JSON.stringify({ workspaces }),
  });
  return transport;
}

async function mounted(): Promise<FakeHttpTransport> {
  const transport = transportWith([WORKSPACE]);
  render(<WorkspaceIdeSurface transport={transport} feed={feed} />);
  await waitFor(
    () => expect(transport.subscriptions.length).toBeGreaterThan(0),
    // Generous on purpose: this gates every test in the file, and the default second is not enough
    // when the whole suite is running. What it waits for is a promise chain, not a duration.
    { timeout: 10_000 },
  );
  act(() => {
    transport.deliver("/api/workspace/w-1/stream", { type: "sharedState", state: CLEAN_STATE });
    transport.deliver("/api/workspace/w-1/stream", { type: "tree", workspaceId: "w-1", tree: TREE });
    transport.deliver("/api/workspace/w-1/stream", { type: "git", status: GIT });
  });
  return transport;
}

it("offers to add one when there are no workspaces, rather than drawing an empty tree", async () => {
  const transport = transportWith([]);
  render(<WorkspaceIdeSurface transport={transport} feed={feed} />);
  expect(await screen.findByText("No workspaces yet")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Add a workspace" })).toBeInTheDocument();
});

it("subscribes to the workspace it resolved, and draws the tree the stream sent", async () => {
  const transport = await mounted();
  expect(transport.subscriptions[0]!.path).toBe("/api/workspace/w-1/stream");
  const tree = await screen.findByRole("tree");
  expect(within(tree).getByRole("button", { name: "Expand src" })).toBeInTheDocument();
  expect(within(tree).getByRole("button", { name: "Open README.md" })).toBeInTheDocument();
});

it("expands a directory by asking the sidecar, not by guessing", async () => {
  const transport = await mounted();
  fireEvent.click(await screen.findByRole("button", { name: "Expand src" }));

  await waitFor(() => {
    const posted = transport.requests.find(
      (request) => request.path === "/api/workspace/w-1/state",
    );
    expect(posted).toBeDefined();
    expect(posted!.body).toMatchObject({
      baseRevision: 0,
      operation: { type: "expand", path: "src" },
    });
    // Every mutation carries one, which is what makes a retry a no-op rather than a second expand.
    expect(typeof (posted!.body as { operationId: unknown }).operationId).toBe("string");
  });
});

it("opens a file, then reads it and shows its text", async () => {
  const transport = await mounted();
  const opened = { ...CLEAN_STATE, revision: 1, orderedOpenPaths: ["README.md"] };
  // The real route answers with the state it applied, and the hook adopts it. Without this the
  // fake's default `{}` would blank the shared state, which is the surface going dark.
  transport.responses.set("POST /api/workspace/w-1/state", {
    status: 200,
    body: JSON.stringify({ state: opened }),
  });
  transport.responses.set("GET /api/workspace/w-1/file?path=README.md", {
    status: 200,
    body: JSON.stringify({
      file: {
        workspaceId: "w-1",
        path: "README.md",
        kind: "markdown",
        revision: "abc",
        text: "# Title\n",
      },
    }),
  });

  fireEvent.click(await screen.findByRole("button", { name: "Open README.md" }));
  expect(await screen.findByRole("tab", { name: "Open README.md" })).toBeInTheDocument();
  await waitFor(() => expect(screen.getByLabelText("Edit README.md")).toHaveValue("# Title\n"));
});

it("shows the source-control section when it is chosen, grouped by how it resolves", async () => {
  await mounted();
  // Matched on the prefix, because the name carries the change count: a reader who cannot see the
  // badge hears it here, so the name moves with the repository.
  fireEvent.click(screen.getByRole("button", { name: /^Show Source Control/ }));

  const group = await screen.findByRole("button", { name: "Collapse Changes" });
  expect(group).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Open src/main.ts" })).toBeInTheDocument();
  expect(screen.queryByRole("tree")).not.toBeInTheDocument();
});

it("shows the branch the stream reported", async () => {
  await mounted();
  expect(await screen.findByText("main")).toBeInTheDocument();
});

it("counts the changed files on the source-control tab, readable from the explorer", async () => {
  await mounted();
  expect(await screen.findByRole("tree")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Show Source Control, 1 changed file" }))
    .toBeInTheDocument();
  // The explorer is not a count of anything, so it keeps the bare name.
  expect(screen.getByRole("button", { name: "Show Explorer" })).toBeInTheDocument();
});

it("hides the sidebar when the toggle asks, and remembers that across a remount", async () => {
  const transport = await mounted();
  expect(await screen.findByRole("tree")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Toggle sidebar" }));
  await waitFor(() => expect(screen.queryByRole("tree")).not.toBeInTheDocument());

  render(<WorkspaceIdeSurface transport={transport} feed={feed} />);
  await waitFor(() => expect(screen.queryByRole("tree")).not.toBeInTheDocument());
});

it("surfaces a stream failure instead of sitting blank", async () => {
  const transport = await mounted();
  act(() => transport.fail("/api/workspace/w-1/stream", "the stream went away"));
  expect(await screen.findByText("the stream went away")).toBeInTheDocument();
});
