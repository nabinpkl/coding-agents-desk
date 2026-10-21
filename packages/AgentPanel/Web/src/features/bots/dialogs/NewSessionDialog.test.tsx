import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { ProjectSummary } from "@agentdesk/agent-feed-wire";
import type { BotMachine } from "@/features/bots/botMachines";
import { NewSessionDialog } from "@/features/bots/dialogs/NewSessionDialog";

const GARDEN: ProjectSummary = {
  projectPath: "/Users/reader/projects/garden",
  displayName: "garden",
  sourceCounts: { claude: 1 },
  sessionCount: 1,
  lastEventAt: 1,
};
const MAC = { label: "mac", feed: {} } as unknown as BotMachine;

function dialog(onStart: (command: unknown) => Promise<void>) {
  render(
    <NewSessionDialog open machine={MAC} projects={[GARDEN]} loading={false} onClose={vi.fn()} onStart={onStart} />,
  );
  return screen.getByRole("button", { name: "Start session" });
}

it("starts only once it has a directory and a name, in the harness picked", async () => {
  const onStart = vi.fn(async () => {});
  const start = dialog(onStart);
  expect(start).toBeDisabled();
  fireEvent.click(screen.getByRole("radio", { name: /garden/ }));
  expect(start).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "  Garden notes " } });
  fireEvent.click(screen.getByRole("radio", { name: /opencode/ }));
  fireEvent.change(screen.getByLabelText("First message"), { target: { value: "Sort the beds\n" } });
  fireEvent.click(start);
  await waitFor(() =>
    expect(onStart).toHaveBeenCalledWith({
      source: "opencode",
      projectPath: GARDEN.projectPath,
      title: "Garden notes",
      prompt: "Sort the beds\n",
    }),
  );
});

it("starts a Claude session in its terminal, with its first message, when nothing else is picked", async () => {
  const onStart = vi.fn(async () => {});
  const start = dialog(onStart);
  expect(screen.getByRole("radio", { name: /Claude Code/ })).toBeChecked();
  fireEvent.click(screen.getByRole("radio", { name: /garden/ }));
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Garden notes" } });
  fireEvent.change(screen.getByLabelText("First message"), { target: { value: "Sort the beds" } });
  fireEvent.click(start);
  await waitFor(() =>
    expect(onStart).toHaveBeenCalledWith({
      source: "claude",
      claudeMode: "terminal",
      projectPath: GARDEN.projectPath,
      title: "Garden notes",
      prompt: "Sort the beds",
    }),
  );
});

it("starts no Claude session without a first message, in either harness, and opencode without one", async () => {
  const onStart = vi.fn(async () => {});
  const start = dialog(onStart);
  fireEvent.click(screen.getByRole("radio", { name: /garden/ }));
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Garden notes" } });
  fireEvent.change(screen.getByLabelText("First message"), { target: { value: "   " } });
  expect(start).toBeDisabled();
  fireEvent.click(screen.getByRole("radio", { name: /Claude Code/ }));
  expect(start).toBeDisabled();
  fireEvent.submit(start.closest("form")!);
  expect(onStart).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("radio", { name: /opencode/ }));
  expect(start).toBeEnabled();
  fireEvent.click(start);
  await waitFor(() =>
    expect(onStart).toHaveBeenCalledWith({
      source: "opencode",
      projectPath: GARDEN.projectPath,
      title: "Garden notes",
    }),
  );
});

it("starts a Claude session through the SDK runner when that is the harness picked", async () => {
  const onStart = vi.fn(async () => {});
  const start = dialog(onStart);
  fireEvent.click(screen.getByRole("radio", { name: /garden/ }));
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Garden notes" } });
  fireEvent.click(screen.getByRole("radio", { name: /Claude SDK/ }));
  fireEvent.change(screen.getByLabelText("First message"), { target: { value: "Sort the beds" } });
  fireEvent.click(start);
  await waitFor(() =>
    expect(onStart).toHaveBeenCalledWith({
      source: "claude",
      claudeMode: "sdk",
      projectPath: GARDEN.projectPath,
      title: "Garden notes",
      prompt: "Sort the beds",
    }),
  );
});

it("keeps everything typed when the start is refused", async () => {
  const start = dialog(async () => {
    throw new Error("opencode is not installed on this machine");
  });
  fireEvent.click(screen.getByRole("radio", { name: /garden/ }));
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Garden notes" } });
  fireEvent.change(screen.getByLabelText("First message"), { target: { value: "Sort the beds" } });
  fireEvent.click(start);
  expect(await screen.findByRole("alert")).toHaveTextContent("opencode is not installed on this machine");
  expect(screen.getByLabelText("First message")).toHaveValue("Sort the beds");
  expect(screen.getByLabelText("Name")).toHaveValue("Garden notes");
  expect(start).toBeEnabled();
});
