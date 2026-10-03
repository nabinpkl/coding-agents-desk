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

/** The header field, which is where the path lives now that it can be typed at. */
function pathField(): HTMLInputElement {
  return screen.getByLabelText("Folder path") as HTMLInputElement;
}

/**
 * Wait until the picker is standing somewhere.
 *
 * A waitFor rather than a findByText: the path stopped being a line of text when the field became
 * typeable, and every test that asked "where am I" was asking about that line.
 */
async function standingIn(path: string): Promise<void> {
  await waitFor(() => expect(pathField().value).toBe(path));
}

it("starts where the sidecar starts, rather than guessing a home directory", async () => {
  // The panel runs in a browser and has no idea what this machine's home is. Asking with null is
  // what keeps that answer in one place.
  const { browse } = picker();
  expect(browse).toHaveBeenCalledWith(null);
  await standingIn("/Users/dev");
});

it("adds the folder being looked at, so the path on screen is the one registered", async () => {
  // There is no separate selection on purpose: navigating into a folder is how you choose it, so
  // nothing can get out of step with what the header says.
  const { onChoose } = picker();
  fireEvent.click(await screen.findByRole("button", { name: "Open projects" }));
  await standingIn("/Users/dev/projects");

  fireEvent.click(screen.getByRole("button", { name: "Add this folder" }));
  expect(onChoose).toHaveBeenCalledWith("/Users/dev/projects");
});

it("offers a way up from anywhere below the root and none at it", async () => {
  picker();
  await standingIn("/Users/dev");
  expect(screen.queryByRole("button", { name: "Go up one folder" })).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Open projects" }));
  await standingIn("/Users/dev/projects");
  fireEvent.click(screen.getByRole("button", { name: "Go up one folder" }));
  await standingIn("/Users/dev");
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
  await standingIn("/Users/dev/projects");

  fireEvent.click(screen.getByRole("button", { name: "New folder" }));
  fireEvent.change(screen.getByLabelText("New folder name"), { target: { value: "ecc" } });
  fireEvent.click(screen.getByRole("button", { name: "Create" }));

  // Asked for the folder being LOOKED AT, not for a path the reader assembled.
  await waitFor(() =>
    expect(createFolder).toHaveBeenCalledWith("/Users/dev/projects", "ecc"));
  // Into the new folder rather than staying put: the picker can then add it, which is almost
  // always why it was made.
  await standingIn("/Users/dev/projects/ecc");
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
  await standingIn("/Users/dev");
  fireEvent.click(screen.getByRole("button", { name: "New folder" }));
  fireEvent.change(screen.getByLabelText("New folder name"), { target: { value: "projects" } });
  fireEvent.click(screen.getByRole("button", { name: "Create" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("already exists");
  // Nothing about where they are went wrong, so the listing is still there to retry from.
  expect(screen.getByRole("button", { name: "Open projects" })).toBeInTheDocument();
});

it("will not create a folder with no name, and Escape abandons the row rather than the picker", async () => {
  const { createFolder, onCancel } = picker();
  await standingIn("/Users/dev");
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
  await standingIn("/Users/dev");
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
  await standingIn("/Users/dev");
  fireEvent.click(screen.getByRole("button", { name: "New folder" }));
  fireEvent.change(screen.getByLabelText("New folder name"), { target: { value: "ecc" } });
  fireEvent.click(screen.getByRole("button", { name: "Open projects" }));

  await standingIn("/Users/dev/projects");
  expect(screen.queryByLabelText("New folder name")).toBeNull();
  expect(createFolder).not.toHaveBeenCalled();
});

it("goes where the reader typed, so a path held elsewhere can be pasted in", async () => {
  // Walking six folders up to reach a path you already have is the cost this picker was built to
  // remove. The field is the other half of that: it was a line of text only while moving one
  // folder at a time was the only way to move at all.
  const { browse } = picker();
  await standingIn("/Users/dev");

  fireEvent.change(pathField(), { target: { value: "/Users/dev/projects/agent-desk" } });
  fireEvent.keyDown(pathField(), { key: "Enter" });

  await standingIn("/Users/dev/projects/agent-desk");
  expect(browse).toHaveBeenCalledWith("/Users/dev/projects/agent-desk");
});

it("hands a typed `~` to the sidecar untouched, because home is the sidecar's to know", async () => {
  // The panel runs in a browser: it cannot be told this machine's home, and a shortcut it expanded
  // against a guess would be a second place holding the answer that decides where the picker starts
  // and how far it may walk. Sending it as written is the panel's whole obligation here.
  const browse = vi.fn(() => Promise.reject(new Error("The requested item was not found.")));
  render(
    <WorkspacePicker
      browse={browse}
      createFolder={vi.fn()}
      onChoose={vi.fn()}
      onCancel={vi.fn()}
    />,
  );
  await screen.findByRole("dialog");

  fireEvent.change(pathField(), { target: { value: "~/projects" } });
  fireEvent.keyDown(pathField(), { key: "Enter" });

  await waitFor(() => expect(browse).toHaveBeenCalledWith("~/projects"));
});

it("puts the path the sidecar resolved back in the field, not the reader's spelling", async () => {
  // A case-insensitive filesystem will happily open `/projects` for a field that says
  // `/Projects`, and the path on screen has to be the one that exists -- it is what the next
  // button registers.
  const browse = vi.fn((path: string | null) =>
    Promise.resolve(path === null
      ? TREE["/Users/dev"]!
      : { path: "/Users/dev/Projects", parent: "/Users/dev", entries: [] }));
  render(
    <WorkspacePicker
      browse={browse}
      createFolder={vi.fn()}
      onChoose={vi.fn()}
      onCancel={vi.fn()}
    />,
  );
  await standingIn("/Users/dev");

  fireEvent.change(pathField(), { target: { value: "/Users/dev/projects" } });
  fireEvent.keyDown(pathField(), { key: "Enter" });

  await standingIn("/Users/dev/Projects");
});

it("keeps a refused path on screen, because the typo is only visible there", async () => {
  const browse = vi.fn((path: string | null) =>
    path === null
      ? Promise.resolve(TREE["/Users/dev"]!)
      : Promise.reject(new Error("The requested item was not found.")));
  render(
    <WorkspacePicker
      browse={browse}
      createFolder={vi.fn()}
      onChoose={vi.fn()}
      onCancel={vi.fn()}
    />,
  );
  await standingIn("/Users/dev");

  fireEvent.change(pathField(), { target: { value: "/Users/dev/projcts" } });
  fireEvent.keyDown(pathField(), { key: "Enter" });

  expect(await screen.findByText("The requested item was not found.")).toBeInTheDocument();
  // Nothing moved, so nothing gets rewritten: the text is the reader's to correct.
  expect(pathField().value).toBe("/Users/dev/projcts");
});

it("does not go anywhere when the field is only looked at", async () => {
  // Return and nothing else. A field that fired on blur would move the picker every time focus
  // went elsewhere, which on a phone is most taps outside it.
  const { browse } = picker();
  await standingIn("/Users/dev");

  fireEvent.change(pathField(), { target: { value: "/Users/dev/projects" } });
  fireEvent.blur(pathField());

  expect(browse).toHaveBeenCalledTimes(1);
  expect(browse).not.toHaveBeenCalledWith("/Users/dev/projects");
  // Still theirs, to finish typing.
  expect(pathField().value).toBe("/Users/dev/projects");
});

it("puts the picker back where it was on Escape, list and all", async () => {
  // After a refused path the field and the body can disagree -- one says a folder, the other says
  // it is not there -- so Escape has to restore the listing too. Restoring only the text would
  // leave the reader looking at two different answers with nothing between them.
  const browse = vi.fn((path: string | null) =>
    path === "/Users/dev/projcts"
      ? Promise.reject(new Error("The requested item was not found."))
      : Promise.resolve(TREE[path ?? "/Users/dev"]!));
  render(
    <WorkspacePicker
      browse={browse}
      createFolder={vi.fn()}
      onChoose={vi.fn()}
      onCancel={vi.fn()}
    />,
  );
  await standingIn("/Users/dev");

  fireEvent.change(pathField(), { target: { value: "/Users/dev/projcts" } });
  fireEvent.keyDown(pathField(), { key: "Enter" });
  expect(await screen.findByText("The requested item was not found.")).toBeInTheDocument();

  fireEvent.keyDown(pathField(), { key: "Escape" });

  await waitFor(() =>
    expect(screen.queryByText("The requested item was not found.")).toBeNull());
  await standingIn("/Users/dev");
  expect(screen.getByRole("button", { name: "Open projects" })).toBeInTheDocument();
});

it("does not close the picker when Escape is pressed in the field", async () => {
  // Escape belongs to the field that was just opened, exactly as it belongs to the folder being
  // named below it. Neither of them may be the way out of the picker.
  const { onCancel, browse } = picker();
  await standingIn("/Users/dev");

  fireEvent.change(pathField(), { target: { value: "/nowhere" } });
  fireEvent.keyDown(pathField(), { key: "Escape" });

  await standingIn("/Users/dev");
  // Re-read of where it already was, which is the restore -- and never a move to what was typed.
  expect(browse).toHaveBeenLastCalledWith("/Users/dev");
  expect(browse).not.toHaveBeenCalledWith("/nowhere");
  expect(onCancel).not.toHaveBeenCalled();
});

it("treats an emptied field as the start, which is what the sidecar calls null", async () => {
  const { browse } = picker();
  await standingIn("/Users/dev");

  fireEvent.change(pathField(), { target: { value: "   " } });
  fireEvent.keyDown(pathField(), { key: "Enter" });

  await waitFor(() => expect(browse).toHaveBeenLastCalledWith(null));
});

it("drops a typed path when a folder in the list is opened instead", async () => {
  // The same rule the name being typed follows: a path belongs to the directory it was typed in,
  // so moving on reports where we are rather than leaving something stale to be submitted later.
  const { browse } = picker();
  await standingIn("/Users/dev");

  fireEvent.change(pathField(), { target: { value: "/somewhere/else" } });
  fireEvent.click(screen.getByRole("button", { name: "Open projects" }));

  await standingIn("/Users/dev/projects");
  expect(browse).not.toHaveBeenCalledWith("/somewhere/else");
});
