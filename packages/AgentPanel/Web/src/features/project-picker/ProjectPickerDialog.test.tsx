// The picker as a dialog: it lists the machine's projects while it is open, and its confirm button
// takes only a directory the caller would not refuse.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { ProjectSummary } from "@agentdesk/agent-feed-wire";
import type { BotMachine } from "@/features/bots/botMachines";
import { ProjectPickerDialog } from "@/features/project-picker/ProjectPickerDialog";

const project = (projectPath: string): ProjectSummary => ({
  projectPath,
  displayName: projectPath.split("/").at(-1)!,
  sourceCounts: {},
  sessionCount: 0,
  lastEventAt: 1,
});

function dialog() {
  const unsubscribe = vi.fn();
  const feed = {
    subscribeInventory: (_paths: readonly string[], handlers: { onProjects: (p: ProjectSummary[], a: []) => void }) => {
      queueMicrotask(() => handlers.onProjects([project("/Users/me/app"), project("/Users/me/open")], []));
      return unsubscribe;
    },
    browseDirectories: vi.fn(),
    createDirectory: vi.fn(),
  };
  const onChoose = vi.fn();
  const view = render(
    <ProjectPickerDialog
      machine={{ label: "this machine", feed } as unknown as BotMachine}
      title="Add a workspace"
      confirmLabel="Add this folder"
      describe={(path) => (path === "/Users/me/open" ? { note: "already a workspace", refused: true } : null)}
      onChoose={onChoose}
      onCancel={vi.fn()}
    />,
  );
  return { onChoose, unsubscribe, view };
}

it("adds the project chosen, and only once one is", async () => {
  const { onChoose } = dialog();
  const add = screen.getByRole<HTMLButtonElement>("button", { name: "Add this folder" });
  expect(add.disabled).toBe(true);
  fireEvent.click(await screen.findByRole("radio", { name: /app/ }));
  expect(add.disabled).toBe(false);
  fireEvent.click(add);
  expect(onChoose).toHaveBeenCalledWith("/Users/me/app");
});

it("offers a refused directory only as a disabled row, and reads the projects only while open", async () => {
  const { unsubscribe, view } = dialog();
  const open = await screen.findByRole<HTMLInputElement>("radio", { name: /open/ });
  expect(open.disabled).toBe(true);
  expect(open.closest("label")!.textContent).toContain("already a workspace");
  view.unmount();
  await waitFor(() => expect(unsubscribe).toHaveBeenCalled());
});
