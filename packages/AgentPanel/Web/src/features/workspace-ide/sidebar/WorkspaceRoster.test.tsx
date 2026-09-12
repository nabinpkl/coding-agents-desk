// What a reader can do to the roster, which until now was "add, and live with it".

import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { WorkspaceSummary } from "@agentdesk/agent-feed-wire";
import { WorkspaceRoster } from "@/features/workspace-ide/sidebar/WorkspaceRoster";

const WORKSPACES: WorkspaceSummary[] = [
  { id: "w-1", name: "First", root: "/projects/first" },
  { id: "w-2", name: "Second", root: "/projects/second" },
  { id: "w-3", name: "Third", root: "/projects/third" },
];

function roster(overrides: Partial<Parameters<typeof WorkspaceRoster>[0]> = {}) {
  const handlers = {
    onSelect: vi.fn(),
    onAdd: vi.fn(),
    onRename: vi.fn(),
    onRemove: vi.fn(),
    onReorder: vi.fn(),
  };
  render(
    <WorkspaceRoster
      workspaces={WORKSPACES}
      workspaceId="w-2"
      {...handlers}
      {...overrides}
    />,
  );
  return handlers;
}

const manage = () => fireEvent.click(screen.getByRole("button", { name: "Manage workspace" }));

it("renames the workspace in place", () => {
  const { onRename } = roster();
  manage();
  fireEvent.click(screen.getByRole("button", { name: "Rename" }));
  const input = screen.getByLabelText("Workspace name");
  fireEvent.change(input, { target: { value: "Renamed" } });
  fireEvent.submit(input);
  expect(onRename).toHaveBeenCalledWith("w-2", "Renamed");
});

it("does not rename when the name comes back unchanged or empty", () => {
  // A no-op write is not harmless here: it broadcasts a roster event to every other reader for a
  // change nobody made.
  const { onRename } = roster();
  manage();
  fireEvent.click(screen.getByRole("button", { name: "Rename" }));
  fireEvent.submit(screen.getByLabelText("Workspace name"));
  fireEvent.click(screen.getByRole("button", { name: "Rename" }));
  fireEvent.change(screen.getByLabelText("Workspace name"), { target: { value: "   " } });
  fireEvent.submit(screen.getByLabelText("Workspace name"));
  expect(onRename).not.toHaveBeenCalled();
});

it("asks before removing, and says the folder survives", () => {
  // The one control here that reads as destructive and is not. Somebody who thinks this deletes
  // their project will never press it, and somebody who thinks it does not will press it twice.
  const { onRemove } = roster();
  manage();
  fireEvent.click(screen.getByRole("button", { name: /Remove/ }));
  expect(onRemove).not.toHaveBeenCalled();
  expect(screen.getByText(/The folder stays on disk/)).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Remove" }));
  expect(onRemove).toHaveBeenCalledWith("w-2");
});

it("lets the confirm be backed out of", () => {
  const { onRemove } = roster();
  manage();
  fireEvent.click(screen.getByRole("button", { name: /Remove/ }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(onRemove).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Rename" })).toBeInTheDocument();
});

it("sends the whole new order when a workspace moves", () => {
  // The store takes a permutation and refuses anything else, so the move is resolved here rather
  // than sending two indices and making the caller own a rule the store already has.
  const { onReorder } = roster();
  manage();
  fireEvent.click(screen.getByRole("button", { name: /Move up/ }));
  expect(onReorder).toHaveBeenCalledWith(["w-2", "w-1", "w-3"]);
});

it("moves down as the mirror of moving up", () => {
  const { onReorder } = roster();
  manage();
  fireEvent.click(screen.getByRole("button", { name: /Move down/ }));
  expect(onReorder).toHaveBeenCalledWith(["w-1", "w-3", "w-2"]);
});

it("cannot move the ends past the ends", () => {
  roster({ workspaceId: "w-1" });
  manage();
  expect(screen.getByRole("button", { name: /Move up/ })).toBeDisabled();
  expect(screen.getByRole("button", { name: /Move down/ })).toBeEnabled();
});

it("offers nothing to manage when there is no workspace to manage", () => {
  roster({ workspaces: [], workspaceId: null });
  expect(screen.getByRole("button", { name: "Manage workspace" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Add workspace" })).toBeEnabled();
});
