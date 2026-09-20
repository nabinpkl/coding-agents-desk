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
vi.mock("@/features/workspace-ide/WorkspaceTerminal", () => ({
  WorkspaceTerminal: ({ workspacePath }: { workspacePath: string }) => (
    <div data-testid="terminal" data-path={workspacePath} />
  ),
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
  transport.responses.set("POST /api/workspace/w-1/state", {
    status: 200,
    body: JSON.stringify({ state: { ...CLEAN_STATE, revision: 1, orderedOpenPaths: ["README.md"] } }),
  });
  transport.responses.set("GET /api/workspace/w-1/file?path=README.md", {
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
  expect(screen.getByRole("button", { name: "Open src/main.ts" })).toBeInTheDocument();
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
  expect(await screen.findByRole("button", { name: "Open src/main.ts" })).toBeInTheDocument();
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

/** The three answers the history popup reads, in the order it reads them. */
function historyAnswers(transport: FakeHttpTransport): void {
  transport.responses.set("GET /api/workspace/w-1/commits?limit=50", {
    status: 200,
    body: JSON.stringify({
      commits: [{
        hash: "1111111111111111111111111111111111111111",
        shortHash: "1111111",
        subject: "teach the bar to look backwards",
        author: "Ada",
        committedAt: Math.round(Date.now() / 1000) - 3600,
        parentCount: 1,
      }],
    }),
  });
  transport.responses.set(
    "GET /api/workspace/w-1/commit?hash=1111111111111111111111111111111111111111",
    {
      status: 200,
      body: JSON.stringify({
        detail: {
          workspaceId: "w-1",
          hash: "1111111111111111111111111111111111111111",
          files: [
            { path: "src/main.ts", status: "M", additions: 2, deletions: 1, previousPath: null },
            { path: "README.md", status: "M", additions: 1, deletions: 0, previousPath: null },
          ],
        },
      }),
    },
  );
  transport.responses.set(
    "GET /api/workspace/w-1/diff?hash=1111111111111111111111111111111111111111&path=README.md",
    {
      status: 200,
      body: JSON.stringify({
        diff: {
          workspaceId: "w-1",
          hash: "1111111111111111111111111111111111111111",
          path: "README.md",
          patch: ["@@ -1,1 +1,2 @@", " # Title", "+a second line", ""].join("\n"),
          truncated: false,
        },
      }),
    },
  );
  transport.responses.set(
    "GET /api/workspace/w-1/diff?hash=1111111111111111111111111111111111111111&path=src%2Fmain.ts",
    {
      status: 200,
      body: JSON.stringify({
        diff: {
          workspaceId: "w-1",
          hash: "1111111111111111111111111111111111111111",
          path: "src/main.ts",
          patch: [
            "diff --git a/src/main.ts b/src/main.ts",
            "@@ -1,2 +1,3 @@",
            " export {};",
            "-const old = 1;",
            "+const fresh = 2;",
            "",
          ].join("\n"),
          truncated: false,
        },
      }),
    },
  );
}

it("opens a commit's file as a diff in the editor, and stays open for the next one", async () => {
  const transport = await mounted();
  historyAnswers(transport);

  fireEvent.click(screen.getByRole("button", { name: "Show git history" }));
  const popup = await screen.findByRole("dialog", { name: "Commit history" });
  const commit = await within(popup).findByRole("button", { name: /teach the bar to look backwards/ });
  // Nothing below the log is fetched until it is asked for: a panel that read every commit's file
  // list to draw a list of subjects would read the whole repository.
  expect(transport.requests.some((request) => request.path.startsWith("/api/workspace/w-1/commit?")))
    .toBe(false);

  fireEvent.click(commit);
  fireEvent.click(await within(popup).findByRole("button", { name: "Open the diff of src/main.ts" }));

  // A tab of its own, named for the file and the commit rather than for the file alone, because
  // every other tab in that strip is a file.
  expect(await screen.findByRole("tab", { name: "Show the diff of main.ts in 1111111" }))
    .toBeInTheDocument();

  // The patch's own header is dropped -- it restates the tab above it -- and the changed lines are
  // what is left, without the markers that classified them.
  const patch = await screen.findByLabelText("Diff of src/main.ts");
  expect(patch.textContent).toContain("const fresh = 2;");
  expect(patch.textContent).toContain("const old = 1;");
  expect(patch.textContent).not.toContain("diff --git");

  // And coloured by the panel's own highlighter rather than left grey: the lines are split into
  // tokens carrying Shiki's two theme variables, which is what the editor paints a file with.
  await waitFor(() => {
    expect(patch.querySelector('span[style*="--shiki-light"]')).not.toBeNull();
  });

  // The panel is still there, on the same commit, with the row it opened marked -- a reader who
  // has found the commit is usually reading more than one of its files.
  expect(within(popup).getByRole("button", { name: "Open the diff of src/main.ts" }))
    .toHaveAttribute("aria-current", "true");
  fireEvent.click(within(popup).getByRole("button", { name: "Open the diff of README.md" }));
  expect(await screen.findByLabelText("Diff of README.md")).toBeInTheDocument();
  // One diff tab, pointed somewhere else, rather than a strip of near-identical tabs.
  expect(screen.getAllByRole("tab", { name: /^Show the diff of/ })).toHaveLength(1);
});

it("takes the reader from a diff to the file it is about, and keeps the diff on its tab", async () => {
  const transport = await mounted();
  historyAnswers(transport);
  transport.responses.set("POST /api/workspace/w-1/state", {
    status: 200,
    body: JSON.stringify({
      state: { ...CLEAN_STATE, revision: 1, orderedOpenPaths: ["src/main.ts"] },
    }),
  });
  transport.responses.set("GET /api/workspace/w-1/file?path=src%2Fmain.ts", {
    status: 200,
    body: JSON.stringify({
      file: {
        workspaceId: "w-1",
        path: "src/main.ts",
        kind: "text",
        revision: "abc",
        text: "export {};\nconst fresh = 2;\n",
      },
    }),
  });

  fireEvent.click(screen.getByRole("button", { name: "Show git history" }));
  const popup = await screen.findByRole("dialog", { name: "Commit history" });
  fireEvent.click(await within(popup).findByRole("button", { name: /teach the bar to look backwards/ }));
  fireEvent.click(await within(popup).findByRole("button", { name: "Open the diff of src/main.ts" }));
  await screen.findByLabelText("Diff of src/main.ts");

  // What the patch says changed, and then what the line says now: that is the order a reader asks
  // the two questions in, so the diff carries the way through to the file.
  fireEvent.click(screen.getByRole("button", { name: "Open src/main.ts" }));

  expect(await screen.findByRole("tab", { name: "Open main.ts" })).toBeInTheDocument();
  await waitFor(() => expect(screen.queryByLabelText("Diff of src/main.ts")).not.toBeInTheDocument());
  // The comparison the reader came for is one click away again rather than gone.
  expect(screen.getByRole("tab", { name: "Show the diff of main.ts in 1111111" })).toBeInTheDocument();
});

it("comes back to the commit it was reading, with the row that opened the diff marked", async () => {
  const transport = await mounted();
  historyAnswers(transport);

  fireEvent.click(screen.getByRole("button", { name: "Show git history" }));
  const popup = await screen.findByRole("dialog", { name: "Commit history" });
  fireEvent.click(await within(popup).findByRole("button", { name: /teach the bar to look backwards/ }));
  fireEvent.click(await within(popup).findByRole("button", { name: "Open the diff of src/main.ts" }));
  await screen.findByLabelText("Diff of src/main.ts");

  fireEvent.keyDown(document, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: "Show git history" }));

  // Still expanded, with no second read of the log or of the commit: the reading position lives on
  // the status bar, so dismissing the panel does not throw it away. Without that, coming back to
  // the commit a reader was in the middle of would mean scrolling and re-expanding every time.
  const reopened = await screen.findByRole("dialog", { name: "Commit history" });
  expect(within(reopened).getByRole("button", { name: "Open the diff of src/main.ts" }))
    .toHaveAttribute("aria-current", "true");
  expect(transport.requests.filter((request) => request.path.startsWith("/api/workspace/w-1/commits")))
    .toHaveLength(1);
});

it("closes the history on Escape, and gives the button its focus back", async () => {
  const transport = await mounted();
  historyAnswers(transport);
  const trigger = screen.getByRole("button", { name: "Show git history" });

  fireEvent.click(trigger);
  const popup = await screen.findByRole("dialog", { name: "Commit history" });
  await waitFor(() => expect(popup).toHaveFocus());

  fireEvent.keyDown(document, { key: "Escape" });

  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  // The reader was standing on that button. Leaving focus on a removed node drops a keyboard
  // reader back at the top of the document.
  expect(trigger).toHaveFocus();
});
