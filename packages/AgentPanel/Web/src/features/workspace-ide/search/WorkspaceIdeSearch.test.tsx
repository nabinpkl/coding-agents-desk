// Both searches through the mounted IDE: the keys that open them, what they ask the sidecar, and
// what opening a result tells the shared state.

import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { WorkspaceSearchResult } from "@agentdesk/agent-feed-wire";
import { CLEAN_STATE, mountWorkspaceIde as mounted } from "@/features/workspace-ide/workspaceIdeHarness";

vi.mock("@/features/workspace-ide/WorkspaceTerminal", () => ({
  WorkspaceTerminal: () => <div data-testid="terminal" />,
}));

beforeEach(() => localStorage.clear());

function doubleShift() {
  const first = new KeyboardEvent("keydown", { key: "Shift", bubbles: true });
  window.dispatchEvent(first);
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift", bubbles: true }));
}

it("double Shift opens quick open, which fuzzy-matches the sidecar's list and opens the pick", async () => {
  const transport = await mounted();
  transport.responses.set("GET /api/workspaces/w-1/files", {
    status: 200,
    body: JSON.stringify({
      workspaceId: "w-1",
      files: ["README.md", "src/features/WorkspaceIdeSurface.tsx", "src/server.ts"],
      truncated: false,
    }),
  });
  transport.responses.set("POST /api/workspaces/w-1/state", {
    status: 200,
    body: JSON.stringify({ state: { ...CLEAN_STATE, revision: 1, orderedOpenPaths: ["src/server.ts"] } }),
  });

  act(() => doubleShift());
  const dialog = await screen.findByRole("dialog", { name: "Go to file" });
  await within(dialog).findByRole("option", { name: /server\.ts/ });

  fireEvent.change(within(dialog).getByRole("combobox"), { target: { value: "srv:12" } });
  const options = within(dialog).getAllByRole("option");
  expect(options[0]).toHaveTextContent("server.ts");
  fireEvent.keyDown(within(dialog).getByRole("combobox"), { key: "Enter" });

  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Go to file" })).toBeNull());
  const posted = transport.requests.find((request) => request.path === "/api/workspaces/w-1/state");
  expect(posted?.body).toMatchObject({ operation: { type: "open", path: "src/server.ts" } });
});

it("the toolbar opens quick open too, which is the way in on a phone", async () => {
  await mounted();
  fireEvent.click(screen.getByRole("button", { name: "Go to file" }));
  const dialog = await screen.findByRole("dialog", { name: "Go to file" });
  fireEvent.keyDown(within(dialog).getByRole("combobox"), { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Go to file" })).toBeNull());
});

it("Cmd+Shift+F opens Search with the caret in it; a result opens as a preview at its line", async () => {
  const transport = await mounted();
  const answer: WorkspaceSearchResult = {
    workspaceId: "w-1",
    query: "alder",
    files: [
      { path: "src/main.ts", matches: [{ line: 7, preview: "const alder = 1;", ranges: [[6, 11]], previewOffset: 0 }] },
    ],
    matchCount: 1,
    truncated: false,
  };
  transport.responses.set("GET /api/workspaces/w-1/search?q=alder", { status: 200, body: JSON.stringify(answer) });

  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "F", metaKey: true, shiftKey: true, bubbles: true }));
  });
  const field = await screen.findByRole("searchbox", { name: "Search in files" });
  await waitFor(() => expect(field).toHaveFocus());

  fireEvent.change(field, { target: { value: "alder" } });
  fireEvent.keyDown(field, { key: "Enter" });
  expect(await screen.findByText("1 result in 1 file")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Open src/main.ts at line 7" }));
  await waitFor(() => {
    const posted = transport.requests.find((request) => request.path === "/api/workspaces/w-1/state");
    expect(posted?.body).toMatchObject({ operation: { type: "preview", path: "src/main.ts" } });
  });
});

it("a search the sidecar cannot run says why, rather than showing no results", async () => {
  const transport = await mounted();
  transport.responses.set("GET /api/workspaces/w-1/search?q=%28&regex=1", {
    status: 400,
    body: JSON.stringify({ error: { code: "invalidQuery", message: "regex parse error: unclosed group" } }),
  });
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true, shiftKey: true, bubbles: true }));
  });
  const field = await screen.findByRole("searchbox", { name: "Search in files" });
  fireEvent.click(screen.getByRole("button", { name: "Use regular expression" }));
  fireEvent.change(field, { target: { value: "(" } });
  fireEvent.keyDown(field, { key: "Enter" });
  expect(await screen.findByText("regex parse error: unclosed group")).toBeInTheDocument();
});
