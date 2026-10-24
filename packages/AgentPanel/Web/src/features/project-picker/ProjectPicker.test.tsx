// What the picker has to get right: the directory a thing starts in can be one no agent has ever
// worked in, and the reader's only way to that one is the served folder browser; and a reader with
// many projects finds one by searching rather than scrolling.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { ProjectSummary, WorkspaceBrowseListing } from "@agentdesk/agent-feed-wire";
import { ProjectPicker } from "@/features/project-picker/ProjectPicker";
import type { BotMachine } from "@/features/bots/botMachines";

const HOME: WorkspaceBrowseListing = {
  path: "/Users/dev",
  parent: null,
  entries: [{ name: "brand-new", path: "/Users/dev/brand-new" }],
};
const BROWSED: WorkspaceBrowseListing = {
  path: "/Users/dev/brand-new",
  parent: "/Users/dev",
  entries: [],
};

const CATALOGUED: ProjectSummary = {
  projectPath: "/Users/dev/projects/agent-desk",
  displayName: "agent-desk",
  sourceCounts: { claude: 3 },
  sessionCount: 3,
  lastEventAt: 1,
};

const OTHER: ProjectSummary = {
  projectPath: "/Users/dev/projects/harbor",
  displayName: "harbor",
  sourceCounts: { opencode: 1 },
  sessionCount: 1,
  lastEventAt: 2,
};

/** Only the label is read here; the picker never calls a machine's feed itself. */
const MAC = { label: "mac", feed: {} } as unknown as BotMachine;

function column(overrides: Partial<Parameters<typeof ProjectPicker>[0]> = {}) {
  const onSelect = vi.fn();
  const browse = vi.fn((path: string | null) => Promise.resolve(path === null ? HOME : BROWSED));
  const createFolder = vi.fn((path: string, name: string) =>
    Promise.resolve({ path: `${path}/${name}`, parent: path, entries: [] }),
  );
  render(
    <ProjectPicker
      machines={[MAC]}
      machine={MAC}
      projects={[CATALOGUED, OTHER]}
      loading={false}
      error={null}
      selectedPath={null}
      onSelect={onSelect}
      browse={browse}
      createFolder={createFolder}
      className=""
      {...overrides}
    />,
  );
  return { onSelect, browse, createFolder };
}

it("binds a folder the catalog has never heard of", async () => {
  // The case the picker exists for: a project with no transcripts yet is in no catalog, and it is
  // exactly the one worth naming a Bot after and starting.
  const { onSelect } = column();
  fireEvent.click(screen.getByRole("button", { name: "Browse folders" }));
  await waitFor(() => screen.getByRole("button", { name: "Open brand-new" }));
  fireEvent.click(screen.getByRole("button", { name: "Open brand-new" }));
  // The picker's header is a field now, so "where am I" is the value in it rather than a line of
  // text beside a title.
  await waitFor(() =>
    expect(screen.getByLabelText<HTMLInputElement>("Folder path").value).toBe("/Users/dev/brand-new"),
  );
  fireEvent.click(screen.getByRole("button", { name: "Use this folder" }));

  expect(onSelect).toHaveBeenCalledWith("/Users/dev/brand-new");
  // And it gets a row of its own, because the list it would otherwise appear in is the catalog's.
  expect(screen.getByRole("radio", { name: /brand-new/ })).toBeTruthy();
});

it("refuses a browsed folder another Bot already holds, before the round trip", async () => {
  // The registry refuses it too. Hearing that only after the whole form is filled in is the
  // difference this check makes.
  const { onSelect } = column({
    describe: (path) =>
      path === "/Users/dev/brand-new" ? { note: "already assigned to a Bot", refused: true } : null,
  });
  fireEvent.click(screen.getByRole("button", { name: "Browse folders" }));
  await waitFor(() => screen.getByRole("button", { name: "Open brand-new" }));
  fireEvent.click(screen.getByRole("button", { name: "Open brand-new" }));
  // The picker's header is a field now, so "where am I" is the value in it rather than a line of
  // text beside a title.
  await waitFor(() =>
    expect(screen.getByLabelText<HTMLInputElement>("Folder path").value).toBe("/Users/dev/brand-new"),
  );
  fireEvent.click(screen.getByRole("button", { name: "Use this folder" }));

  expect(onSelect).not.toHaveBeenCalled();
  expect(screen.getByRole("alert").textContent).toContain("already assigned to a Bot");
});

it("offers the catalogue without browsing, which is still the common case", () => {
  const { onSelect, browse } = column();
  fireEvent.click(screen.getByRole("radio", { name: /agent-desk/ }));

  expect(onSelect).toHaveBeenCalledWith("/Users/dev/projects/agent-desk");
  expect(browse).not.toHaveBeenCalled();
});

it("says a machine with no projects can still be browsed", () => {
  // Otherwise an empty catalogue reads as "nothing can be done here", which is now false.
  column({ projects: [] });
  expect(screen.getByRole("status").textContent).toContain("Browse for a folder");
});

it("narrows the projects to those holding every word searched, in the name or the path", () => {
  column();
  const search = screen.getByRole("searchbox", { name: "Search projects" });
  fireEvent.change(search, { target: { value: "projects KUB" } });
  expect(screen.queryByRole("radio", { name: /agent-desk/ })).toBeNull();
  expect(screen.getByRole("radio", { name: /harbor/ })).toBeTruthy();

  fireEvent.change(search, { target: { value: "nothing-like-it" } });
  expect(screen.getByRole("status").textContent).toContain("No project matches");

  // Escape clears it, and every project is back.
  fireEvent.keyDown(search, { key: "Escape" });
  expect(screen.getAllByRole("radio")).toHaveLength(2);
});

it("puts projects named for the search above those that only hold it in their path", () => {
  column({
    projects: [{ ...OTHER, projectPath: "/Users/dev/desk-notes/scratch", displayName: "scratch" }, CATALOGUED],
  });
  fireEvent.change(screen.getByRole("searchbox", { name: "Search projects" }), { target: { value: "desk" } });
  expect(screen.getAllByRole("radio").map((radio) => (radio as HTMLInputElement).value)).toEqual([
    "/Users/dev/projects/agent-desk",
    "/Users/dev/desk-notes/scratch",
  ]);
});

it("may lead with a row that chooses no directory, checked while nothing is selected", () => {
  const chooseNone = vi.fn();
  const { onSelect } = column({
    noPathOption: { label: "New repository", detail: "in the run's folder", onSelect: chooseNone },
  });
  const none = screen.getByRole("radio", { name: /New repository/ }) as HTMLInputElement;
  expect(none.checked).toBe(true);
  // A search narrows projects only: the row is not one, so it stays.
  fireEvent.change(screen.getByRole("searchbox", { name: "Search projects" }), { target: { value: "harbor" } });
  expect(screen.getByRole("radio", { name: /New repository/ })).toBeTruthy();
  fireEvent.click(screen.getByRole("radio", { name: /harbor/ }));
  expect(onSelect).toHaveBeenCalledWith("/Users/dev/projects/harbor");
  expect(chooseNone).not.toHaveBeenCalled();
});

it("shows a selection the catalog does not hold, so it is never chosen out of sight", () => {
  column({ selectedPath: "/Users/dev/brand-new" });
  expect(screen.getByRole<HTMLInputElement>("radio", { name: /brand-new/ }).checked).toBe(true);
});

it("says under a row what the caller has to say about it, and disables only a refused one", () => {
  column({
    describe: (path) =>
      path === CATALOGUED.projectPath
        ? { note: "not a git repository yet", refused: false }
        : { note: "does not exist", refused: true },
  });
  const desk = screen.getByRole<HTMLInputElement>("radio", { name: /agent-desk/ });
  const harbor = screen.getByRole<HTMLInputElement>("radio", { name: /harbor/ });
  expect([desk.disabled, harbor.disabled]).toEqual([false, true]);
  expect(desk.closest("label")!.textContent).toContain("not a git repository yet");
  expect(harbor.closest("label")!.textContent).toContain("does not exist");
});
