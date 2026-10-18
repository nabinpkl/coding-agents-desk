// The history popup, driven through the same fake transport the rest of the IDE is: the log, one
// commit's message and files, and the diff that opens in the editor behind it.
//
// Apart from `WorkspaceIdeSurface.test.tsx` because it is a different question -- that file asks
// what the three panes do, and this one asks what looking backwards through them does -- and
// because between them they were past the file-length cap.

import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { FakeHttpTransport } from "@/features/activity-feed/transport/FakeHttpTransport";
import { CLEAN_STATE, GIT, mountWorkspaceIde as mounted } from "@/features/workspace-ide/workspaceIdeHarness";

// The terminal pane is a whole other surface with an xterm inside it; this file is about history.
vi.mock("@/features/workspace-ide/WorkspaceTerminal", () => ({
  WorkspaceTerminal: ({ workspacePath }: { workspacePath: string }) => (
    <div data-testid="terminal" data-path={workspacePath} />
  ),
}));

beforeEach(() => localStorage.clear());

/** Long enough to be cut, which is the shape most of this repository's messages have. */
const BODY = [
  "the bar had no way to look backwards at all",
  "",
  "line three",
  "line four",
  "line five",
  "line six",
  "line seven, which is past the cut",
].join("\n");

/** The three answers the history popup reads, in the order it reads them. */
function historyAnswers(transport: FakeHttpTransport): void {
  transport.responses.set("GET /api/workspaces/w-1/commits?limit=50", {
    status: 200,
    body: JSON.stringify({
      commits: [
        {
          hash: "1111111111111111111111111111111111111111",
          shortHash: "1111111",
          subject: "teach the bar to look backwards",
          author: "Ada",
          committedAt: Math.round(Date.now() / 1000) - 3600,
          parentCount: 1,
        },
      ],
    }),
  });
  transport.responses.set("GET /api/workspaces/w-1/commit?hash=1111111111111111111111111111111111111111", {
    status: 200,
    body: JSON.stringify({
      detail: {
        workspaceId: "w-1",
        hash: "1111111111111111111111111111111111111111",
        body: BODY,
        files: [
          { path: "src/main.ts", status: "M", additions: 2, deletions: 1, previousPath: null },
          { path: "README.md", status: "M", additions: 1, deletions: 0, previousPath: null },
        ],
      },
    }),
  });
  transport.responses.set("GET /api/workspaces/w-1/diff?hash=1111111111111111111111111111111111111111&path=README.md", {
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
  });
  transport.responses.set(
    "GET /api/workspaces/w-1/diff?hash=1111111111111111111111111111111111111111&path=src%2Fmain.ts",
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

it("says why a commit happened, and cuts a long message down to the log around it", async () => {
  const transport = await mounted();
  historyAnswers(transport);

  fireEvent.click(screen.getByRole("button", { name: "Show git history" }));
  const popup = await screen.findByRole("dialog", { name: "Commit history" });
  fireEvent.click(await within(popup).findByRole("button", { name: /teach the bar to look backwards/ }));

  // Cut on the way in: the commit above it and the files below it are what the reader is
  // navigating by, and a forty-line message would push both off the panel.
  const whole = await within(popup).findByRole("button", { name: "Show the whole message" });
  expect(within(popup).getByText(/the bar had no way to look backwards/)).toBeInTheDocument();
  expect(within(popup).queryByText(/line seven/)).not.toBeInTheDocument();

  fireEvent.click(whole);
  expect(within(popup).getByText(/line seven, which is past the cut/)).toBeInTheDocument();

  fireEvent.click(within(popup).getByRole("button", { name: "Show less" }));
  expect(within(popup).queryByText(/line seven/)).not.toBeInTheDocument();
});

it("opens a commit's file as a diff in the editor, and stays open for the next one", async () => {
  const transport = await mounted();
  historyAnswers(transport);

  fireEvent.click(screen.getByRole("button", { name: "Show git history" }));
  const popup = await screen.findByRole("dialog", { name: "Commit history" });
  const commit = await within(popup).findByRole("button", { name: /teach the bar to look backwards/ });
  // Nothing below the log is fetched until it is asked for: a panel that read every commit's file
  // list to draw a list of subjects would read the whole repository.
  expect(transport.requests.some((request) => request.path.startsWith("/api/workspaces/w-1/commit?"))).toBe(false);

  fireEvent.click(commit);
  fireEvent.click(await within(popup).findByRole("button", { name: "Open the diff of src/main.ts" }));

  // A tab of its own, named for the file and the commit rather than for the file alone, because
  // every other tab in that strip is a file.
  expect(await screen.findByRole("tab", { name: "Show the diff of main.ts in 1111111" })).toBeInTheDocument();

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
  expect(within(popup).getByRole("button", { name: "Open the diff of src/main.ts" })).toHaveAttribute(
    "aria-current",
    "true",
  );
  fireEvent.click(within(popup).getByRole("button", { name: "Open the diff of README.md" }));
  expect(await screen.findByLabelText("Diff of README.md")).toBeInTheDocument();
  // One diff tab, pointed somewhere else, rather than a strip of near-identical tabs.
  expect(screen.getAllByRole("tab", { name: /^Show the diff of/ })).toHaveLength(1);
});

it("takes the reader from a diff to the file it is about, and keeps the diff on its tab", async () => {
  const transport = await mounted();
  historyAnswers(transport);
  transport.responses.set("POST /api/workspaces/w-1/state", {
    status: 200,
    body: JSON.stringify({
      state: { ...CLEAN_STATE, revision: 1, orderedOpenPaths: ["src/main.ts"] },
    }),
  });
  transport.responses.set("GET /api/workspaces/w-1/file?path=src%2Fmain.ts", {
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
  expect(within(reopened).getByRole("button", { name: "Open the diff of src/main.ts" })).toHaveAttribute(
    "aria-current",
    "true",
  );
  expect(transport.requests.filter((request) => request.path.startsWith("/api/workspaces/w-1/commits"))).toHaveLength(
    1,
  );
});

it("keeps the history up while the editor is in use, and drops it on a click elsewhere", async () => {
  const transport = await mounted();
  historyAnswers(transport);

  fireEvent.click(screen.getByRole("button", { name: "Show git history" }));
  const popup = await screen.findByRole("dialog", { name: "Commit history" });
  fireEvent.click(await within(popup).findByRole("button", { name: /teach the bar to look backwards/ }));
  fireEvent.click(await within(popup).findByRole("button", { name: "Open the diff of src/main.ts" }));
  const patch = await screen.findByLabelText("Diff of src/main.ts");

  // Reading the patch is reading the commit, and so is being done with one of its files. Neither
  // is the reader leaving the history behind, so neither dismisses it.
  fireEvent.pointerDown(patch);
  expect(screen.getByRole("dialog", { name: "Commit history" })).toBeInTheDocument();
  const close = screen.getByRole("button", { name: "Close the diff of main.ts" });
  fireEvent.pointerDown(close);
  fireEvent.click(close);
  await waitFor(() => expect(screen.queryByLabelText("Diff of src/main.ts")).not.toBeInTheDocument());
  expect(screen.getByRole("dialog", { name: "Commit history" })).toBeInTheDocument();

  // A pointer going somewhere else to work does: the reader is done looking back.
  fireEvent.pointerDown(screen.getByRole("button", { name: "Open README.md" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
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

it("opens a source-control row as its uncommitted diff, and reads it again as git moves", async () => {
  const transport = await mounted();
  const change = (line: string) => ({
    status: 200,
    body: JSON.stringify({
      diff: {
        workspaceId: "w-1",
        path: "src/main.ts",
        patch: `diff --git a/src/main.ts b/src/main.ts\n@@ -1 +1 @@\n-export {};\n+${line}\n`,
        truncated: false,
      },
    }),
  });
  const asked = () =>
    transport.requests.filter((request) => request.path === "/api/workspaces/w-1/change?path=src%2Fmain.ts").length;
  transport.responses.set("GET /api/workspaces/w-1/change?path=src%2Fmain.ts", change("first edit"));

  fireEvent.click(screen.getByRole("button", { name: /^Show Source Control/ }));
  const row = await screen.findByRole("button", { name: "Show the diff of src/main.ts" });
  fireEvent.click(row);

  const patch = await screen.findByLabelText("Diff of src/main.ts");
  await waitFor(() => expect(patch.textContent).toContain("first edit"));
  expect(screen.getByRole("tab", { name: "Show the uncommitted diff of main.ts" })).toBeInTheDocument();
  expect(row).toHaveAttribute("aria-current", "true");
  expect(asked()).toBe(1);

  // The file is still being written, so a new status reads the diff again, without blanking it.
  transport.responses.set("GET /api/workspaces/w-1/change?path=src%2Fmain.ts", change("second edit"));
  act(() => {
    transport.deliver("/api/workspaces/w-1/stream", { type: "git", status: { ...GIT } });
  });
  await waitFor(() => expect(screen.getByLabelText("Diff of src/main.ts").textContent).toContain("second edit"));
  expect(asked()).toBe(2);
});
