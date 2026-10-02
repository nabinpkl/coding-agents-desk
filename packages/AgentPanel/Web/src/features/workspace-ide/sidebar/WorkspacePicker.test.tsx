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
  const createFolder = vi.fn((path: string, name: string) =>
    Promise.resolve({
      path: `${path}/${name}`,
      parent: path,
      entries: [],
    }));
  const onChoose = vi.fn();
  const onCancel = vi.fn();
  render(
    <WorkspacePicker
      browse={browse}
      createFolder={createFolder}
      onChoose={onChoose}
      onCancel={onCancel}
    />,
  );
  return { browse, createFolder, onChoose, onCancel };
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
  render(
    <WorkspacePicker
      browse={browse}
      createFolder={vi.fn()}
      onChoose={vi.fn()}
      onCancel={vi.fn()}
    />,
  );
  expect(await screen.findByText("Outside the home directory.")).toBeInTheDocument();
});

it("makes a folder in the directory on screen, and stands in it", async () => {
  // Browsing can only ever show what already exists, so a reader who wants a folder nobody has
  // made yet had no way to get one -- on a phone, where typing an absolute path is exactly what
  // this picker replaced.
  const { createFolder, onChoose } = picker();
  fireEvent.click(await screen.findByRole("button", { name: "Open projects" }));
  await screen.findByText("/Users/dev/projects");

  fireEvent.click(screen.getByRole("button", { name: "New folder" }));
  fireEvent.change(screen.getByLabelText("New folder name"), { target: { value: "ecc" } });
  fireEvent.click(screen.getByRole("button", { name: "Create" }));

  // Asked for the folder being LOOKED AT, not for a path the reader assembled.
  await waitFor(() =>
    expect(createFolder).toHaveBeenCalledWith("/Users/dev/projects", "ecc"));
  // Into the new folder rather than staying put: the picker can then add it, which is almost
  // always why it was made.
  expect(await screen.findByText("/Users/dev/projects/ecc")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Add this folder" }));
  expect(onChoose).toHaveBeenCalledWith("/Users/dev/projects/ecc");
});

it("keeps the listing and says why when a name is refused", async () => {
  // The sidecar's message rather than one invented here: "that name is taken" is the answer a
  // reader gets most often, and a refusal they cannot read is a refusal they try again the same.
  const createFolder = vi.fn(() =>
    Promise.reject(new Error("A folder with that name already exists here.")));
  render(
    <WorkspacePicker
      browse={(path) => Promise.resolve(TREE[path ?? "/Users/dev"]!)}
      createFolder={createFolder}
      onChoose={vi.fn()}
      onCancel={vi.fn()}
    />,
  );
  await screen.findByText("/Users/dev");
  fireEvent.click(screen.getByRole("button", { name: "New folder" }));
  fireEvent.change(screen.getByLabelText("New folder name"), { target: { value: "projects" } });
  fireEvent.click(screen.getByRole("button", { name: "Create" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("already exists");
  // Nothing about where they are went wrong, so the listing is still there to retry from.
  expect(screen.getByRole("button", { name: "Open projects" })).toBeInTheDocument();
});

it("will not create a folder with no name, and Escape abandons the row rather than the picker", async () => {
  const { createFolder, onCancel } = picker();
  await screen.findByText("/Users/dev");
  fireEvent.click(screen.getByRole("button", { name: "New folder" }));
  expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();

  fireEvent.change(screen.getByLabelText("New folder name"), { target: { value: "  " } });
  expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();

  fireEvent.keyDown(screen.getByLabelText("New folder name"), { key: "Escape" });
  expect(screen.queryByLabelText("New folder name")).toBeNull();
  expect(createFolder).not.toHaveBeenCalled();
  expect(onCancel).not.toHaveBeenCalled();
});

it("creates on Enter, because a name is a name and Return is how everyone types one", async () => {
  const { createFolder } = picker();
  await screen.findByText("/Users/dev");
  fireEvent.click(screen.getByRole("button", { name: "New folder" }));
  fireEvent.change(screen.getByLabelText("New folder name"), { target: { value: "scratch" } });
  fireEvent.keyDown(screen.getByLabelText("New folder name"), { key: "Enter" });

  await waitFor(() => expect(createFolder).toHaveBeenCalledWith("/Users/dev", "scratch"));
});

it("drops the name being typed when you navigate, rather than creating it somewhere else", async () => {
  // A name belongs to the directory it was typed in. Carrying it across a move would put that
  // folder somewhere the reader was not looking when they named it, which is the one thing a
  // picker that shows where it is exists to prevent.
  const { createFolder } = picker();
  await screen.findByText("/Users/dev");
  fireEvent.click(screen.getByRole("button", { name: "New folder" }));
  fireEvent.change(screen.getByLabelText("New folder name"), { target: { value: "ecc" } });
  fireEvent.click(screen.getByRole("button", { name: "Open projects" }));

  expect(await screen.findByText("/Users/dev/projects")).toBeInTheDocument();
  expect(screen.queryByLabelText("New folder name")).toBeNull();
  expect(createFolder).not.toHaveBeenCalled();
});
