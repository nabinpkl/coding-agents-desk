// What the picker has to get right: it browses a filesystem it cannot see, so every answer on
// screen comes from the sidecar and the reader's only handle on "where am I" is the path.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { WorkspaceBrowseListing } from "@agentdesk/agent-feed-wire";
import { WorkspacePicker } from "@/features/workspace-ide/sidebar/WorkspacePicker";

const TREE: Record<string, WorkspaceBrowseListing> = {
  "/Users/dev": {
    path: "/Users/dev",
    parent: null,
    entries: [{ name: "projects", path: "/Users/dev/projects" }],
  },
  "/Users/dev/projects": {
    path: "/Users/dev/projects",
    parent: "/Users/dev",
    entries: [{ name: "agent-desk", path: "/Users/dev/projects/agent-desk" }],
  },
  "/Users/dev/projects/agent-desk": {
    path: "/Users/dev/projects/agent-desk",
    parent: "/Users/dev/projects",
    entries: [],
  },
};

function picker() {
  const browse = vi.fn((path: string | null) =>
    Promise.resolve(TREE[path ?? "/Users/dev"]!));
  const onChoose = vi.fn();
  const onCancel = vi.fn();
  render(<WorkspacePicker browse={browse} onChoose={onChoose} onCancel={onCancel} />);
  return { browse, onChoose, onCancel };
}

it("starts where the sidecar starts, rather than guessing a home directory", async () => {
  // The panel runs in a browser and has no idea what this machine's home is. Asking with null is
  // what keeps that answer in one place.
  const { browse } = picker();
  expect(browse).toHaveBeenCalledWith(null);
  expect(await screen.findByText("/Users/dev")).toBeInTheDocument();
});

it("adds the folder being looked at, so the path on screen is the one registered", async () => {
  // There is no separate selection on purpose: navigating into a folder is how you choose it, so
  // nothing can get out of step with what the header says.
  const { onChoose } = picker();
  fireEvent.click(await screen.findByRole("button", { name: "Open projects" }));
  await screen.findByText("/Users/dev/projects");

  fireEvent.click(screen.getByRole("button", { name: "Add this folder" }));
  expect(onChoose).toHaveBeenCalledWith("/Users/dev/projects");
});

it("offers a way up from anywhere below the root and none at it", async () => {
  picker();
  await screen.findByText("/Users/dev");
  expect(screen.queryByRole("button", { name: "Go up one folder" })).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Open projects" }));
  await screen.findByText("/Users/dev/projects");
  fireEvent.click(screen.getByRole("button", { name: "Go up one folder" }));
  await waitFor(() => expect(screen.getByText("/Users/dev")).toBeInTheDocument());
});

it("says an empty folder is still a choice, rather than looking broken", async () => {
  picker();
  fireEvent.click(await screen.findByRole("button", { name: "Open projects" }));
  fireEvent.click(await screen.findByRole("button", { name: "Open agent-desk" }));
  expect(await screen.findByText(/This one can still be chosen/)).toBeInTheDocument();
});

it("shows a refusal instead of an empty folder, because those look identical", async () => {
  const browse = vi.fn(() => Promise.reject(new Error("Outside the home directory.")));
  render(<WorkspacePicker browse={browse} onChoose={vi.fn()} onCancel={vi.fn()} />);
  expect(await screen.findByText("Outside the home directory.")).toBeInTheDocument();
});
