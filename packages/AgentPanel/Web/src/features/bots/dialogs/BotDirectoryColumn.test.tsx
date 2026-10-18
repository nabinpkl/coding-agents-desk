// What the column has to get right: the directory a Bot is bound to can be one no agent has ever
// worked in, and the reader's only way to that one is the served folder picker.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { ProjectSummary, WorkspaceBrowseListing } from "@agentdesk/agent-feed-wire";
import { BotDirectoryColumn } from "@/features/bots/dialogs/BotDirectoryColumn";
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

/** Only the label is read here; a column never calls a machine's feed itself. */
const MAC = { label: "mac", feed: {} } as unknown as BotMachine;

function column(overrides: Partial<Parameters<typeof BotDirectoryColumn>[0]> = {}) {
  const onSelect = vi.fn();
  const browse = vi.fn((path: string | null) => Promise.resolve(path === null ? HOME : BROWSED));
  const createFolder = vi.fn((path: string, name: string) =>
    Promise.resolve({ path: `${path}/${name}`, parent: path, entries: [] }),
  );
  render(
    <BotDirectoryColumn
      machines={[MAC]}
      machine={MAC}
      onMachine={vi.fn()}
      projects={[CATALOGUED]}
      loading={false}
      error={null}
      claimed={new Set()}
      selectedPath={null}
      onSelect={onSelect}
      browse={browse}
      createFolder={createFolder}
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
  const { onSelect } = column({ claimed: new Set(["/Users/dev/brand-new"]) });
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
