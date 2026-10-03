// The three panes: the tree, the file a reader opens, the sidebar sections, and the status bar
// that survives all of them being hidden.
//
// Looking BACKWARDS through those panes -- the history popup and the diff it opens -- is
// `history/WorkspaceIdeHistory.test.tsx`, which mounts the same surface through the same harness.

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { WorkspaceTreeNode } from "@agentdesk/agent-feed-wire";
import { WorkspaceIdeSurface } from "@/features/workspace-ide/WorkspaceIdeSurface";
import {
  CLEAN_STATE,
  feed,
  mountWorkspaceIde as mounted,
  transportWith,
  WORKSPACE,
} from "@/features/workspace-ide/workspaceIdeHarness";

// The terminal pane is a whole other surface with an xterm inside it; this file is about the IDE.
vi.mock("@/features/workspace-ide/WorkspaceTerminal", () => ({
  WorkspaceTerminal: ({ workspacePath }: { workspacePath: string }) => (
    <div data-testid="terminal" data-path={workspacePath} />
  ),
}));

beforeEach(() => localStorage.clear());

it("offers to add one when there are no workspaces, rather than drawing an empty tree", async () => {
  const transport = transportWith([]);
  render(<WorkspaceIdeSurface transport={transport} feed={feed} />);
  expect(await screen.findByText("No workspaces yet")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Add a workspace" })).toBeInTheDocument();
});

it("subscribes to the workspace it resolved, and draws the tree the stream sent", async () => {
  const transport = await mounted();
  expect(transport.subscriptions[0]!.path).toBe("/api/workspaces/w-1/stream");
  const tree = await screen.findByRole("tree");
  expect(within(tree).getByRole("button", { name: "Expand src" })).toBeInTheDocument();
  expect(within(tree).getByRole("button", { name: "Open README.md" })).toBeInTheDocument();
});

it("expands a directory by asking the sidecar, not by guessing", async () => {
  const transport = await mounted();
  fireEvent.click(await screen.findByRole("button", { name: "Expand src" }));

  await waitFor(() => {
    const posted = transport.requests.find(
      (request) => request.path === "/api/workspaces/w-1/state",
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
  transport.responses.set("POST /api/workspaces/w-1/state", {
    status: 200,
    body: JSON.stringify({ state: opened }),
  });
  transport.responses.set("GET /api/workspaces/w-1/file?path=README.md", {
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

  // Markdown opens RENDERED, so what proves the read landed is the document, not a textarea. The
  // control offering the way back to the source is the tell that this is the preview.
  expect(await screen.findByRole("button", { name: "Edit file" })).toBeInTheDocument();
  expect(screen.queryByLabelText("Edit README.md")).not.toBeInTheDocument();

  // And it is read in the DOCUMENT register rather than the transcript one: the measure, the
  // heading scale and the rhythm all hang off this class. jsdom measures nothing, so this pins
  // the wiring -- that the IDE asks for the register -- and the browser check pins the pixels.
  expect(screen.getByText("Title").closest(".agent-panel-md--document")).not.toBeNull();
});

it("opens markdown rendered, and keeps the source once a reader asks for it", async () => {
  // A reader opening a markdown file is almost always reading it. Everything else opens as source,
  // because for every other editable kind the source IS the document.
  const transport = await mounted();
  transport.responses.set("POST /api/workspaces/w-1/state", {
    status: 200,
    body: JSON.stringify({ state: { ...CLEAN_STATE, revision: 1, orderedOpenPaths: ["README.md"] } }),
  });
  transport.responses.set("GET /api/workspaces/w-1/file?path=README.md", {
    status: 200,
    body: JSON.stringify({
      file: { workspaceId: "w-1", path: "README.md", kind: "markdown", revision: "abc", text: "# Title\n" },
    }),
  });

  fireEvent.click(await screen.findByRole("button", { name: "Open README.md" }));
  fireEvent.click(await screen.findByRole("button", { name: "Edit file" }));
  await waitFor(() => expect(screen.getByLabelText("Edit README.md")).toHaveValue("# Title\n"));

  // The choice outlives the mount, and it is a CHOICE rather than a flag: remembering "previewed"
  // would have come back as the opposite of what was asked for, because preview is the default.
  render(<WorkspaceIdeSurface transport={transport} feed={feed} />);
  await waitFor(() => {
    expect(screen.getAllByLabelText("Edit README.md").length).toBeGreaterThan(0);
  });
});

it("shows the source-control section when it is chosen, grouped by how it resolves", async () => {
  await mounted();
  // Matched on the prefix, because the name carries the change count: a reader who cannot see the
  // badge hears it here, so the name moves with the repository.
  fireEvent.click(screen.getByRole("button", { name: /^Show Source Control/ }));

  const group = await screen.findByRole("button", { name: "Collapse Changes" });
  expect(group).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Show the diff of src/main.ts" })).toBeInTheDocument();
  expect(screen.queryByRole("tree")).not.toBeInTheDocument();
});

it("keeps the branch on the status bar, where hiding the sidebar cannot take it away", async () => {
  await mounted();
  const status = await screen.findByLabelText("Workspace status");
  // The count rides the name because the pill drawing it is invisible to a screen reader.
  expect(within(status).getByRole("button", { name: "main, 1 changed file. Show Source Control" }))
    .toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Toggle sidebar" }));

  await waitFor(() => expect(screen.queryByRole("tree")).not.toBeInTheDocument());
  expect(within(status).getByText("main")).toBeInTheDocument();
});

it("takes the branch's click to the changes it is counting, sidebar and all", async () => {
  await mounted();
  const status = await screen.findByLabelText("Workspace status");
  fireEvent.click(screen.getByRole("button", { name: "Toggle sidebar" }));
  await waitFor(() => expect(screen.queryByRole("tree")).not.toBeInTheDocument());

  fireEvent.click(within(status).getByRole("button", { name: /Show Source Control$/ }));

  // Selecting the section alone would leave the reader clicking a control with no visible effect,
  // since the section it selects lives in the pane they just hid.
  expect(await screen.findByRole("button", { name: "Show the diff of src/main.ts" })).toBeInTheDocument();
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

/**
 * The names of a tree's rows, top to bottom, which is what an order is.
 *
 * Off each row's button rather than its text: a row's text also carries the git letter, so a changed
 * file would read as `srcM` and an order test would fail on a change rather than on an order.
 */
function rowNames(tree: HTMLElement): string[] {
  return within(tree).getAllByRole("treeitem").map(
    (row) => (row.querySelector("button")?.getAttribute("aria-label") ?? "")
      .replace(/^(Expand|Collapse|Open) /, ""),
  );
}

it("orders the tree by when each thing changed, putting the newest first", async () => {
  const transport = await mounted();
  const tree = await screen.findByRole("tree");

  // Delivered here rather than taken from the shared fixture because the order can only be seen
  // where it disagrees with the order the rows arrive in: a directory and a file beside it sort the
  // same way in both orders, since folders stay above files.
  const byName: WorkspaceTreeNode[] = [
    { name: "alpha.ts", path: "alpha.ts", isDirectory: false, expanded: false, gitStatus: null, modifiedAt: 1_700_000_000_000, children: [] },
    { name: "beta.ts", path: "beta.ts", isDirectory: false, expanded: false, gitStatus: null, modifiedAt: 1_900_000_000_000, children: [] },
  ];
  act(() => transport.deliver("/api/workspaces/w-1/stream", { type: "tree", workspaceId: "w-1", tree: byName }));
  expect(rowNames(tree)).toEqual(["alpha.ts", "beta.ts"]);

  fireEvent.click(screen.getByRole("button", { name: "Sort by modified date" }));

  expect(rowNames(tree)).toEqual(["beta.ts", "alpha.ts"]);
  expect(screen.getByRole("button", { name: "Sort by modified date" }))
    .toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("button", { name: "Sort by name" }))
    .toHaveAttribute("aria-pressed", "false");
});

it("remembers the order across a remount, because it is how this reader arranged it", async () => {
  const transport = await mounted();
  await screen.findByRole("tree");

  fireEvent.click(screen.getByRole("button", { name: "Sort by modified date" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Sort by modified date" }))
      .toHaveAttribute("aria-pressed", "true"));

  render(<WorkspaceIdeSurface transport={transport} feed={feed} />);
  await waitFor(() =>
    expect(screen.getAllByRole("button", { name: "Sort by modified date" })[0])
      .toHaveAttribute("aria-pressed", "true"));
});

/**
 * The sidebar's section strip, which is where the order control lives.
 *
 * Scoped rather than queried across the page because the status bar's branch button ends its name
 * with the same words ("main. Show Source Control"), and a pattern loose enough to find one finds
 * both.
 */
function sections(): HTMLElement {
  return screen.getByRole("navigation", { name: "Workspace sidebar sections" });
}

it("takes the order control away in the sections that have no tree to reorder", async () => {
  await mounted();
  await screen.findByRole("tree");

  fireEvent.click(within(sections()).getByRole("button", { name: /Show Source Control/ }));
  await screen.findByRole("button", { name: "Show Explorer" });
  expect(within(sections()).queryByRole("button", { name: "Sort by modified date" }))
    .not.toBeInTheDocument();
});

it("surfaces a stream failure instead of sitting blank", async () => {
  const transport = await mounted();
  act(() => transport.fail("/api/workspaces/w-1/stream", "the stream went away"));
  expect(await screen.findByText("the stream went away")).toBeInTheDocument();
});

it("opens the lower pane on the workspace itself, not on a wall of tmux sessions", async () => {
  await mounted();
  // Off until asked for: the pane costs a shell, and a reader who wants one says so.
  expect(screen.queryByTestId("terminal")).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Toggle terminal" }));

  // The workspace ROOT, which is what makes this the IDE's terminal rather than a shell that
  // happens to be nearby. jsdom runs no xterm, so the mock stands in for the screen and this pins
  // the wiring: which directory the pane was pointed at.
  const terminal = await screen.findByTestId("terminal");
  expect(terminal.getAttribute("data-path")).toBe(WORKSPACE.root);
});
