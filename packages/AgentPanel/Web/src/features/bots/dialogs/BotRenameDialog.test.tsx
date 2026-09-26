/**
 * Renaming a Bot: seeded from the record, submitted as a restyle, and held open on failure.
 */

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BotRenameDialog } from "@/features/bots/dialogs/BotRenameDialog";
import type { BotView } from "@agentdesk/agent-feed-wire";

const bot = {
  botId: "bot-1",
  name: "Captain",
  environment: { kind: "directory", path: "/projects/alpha" },
  metadata: { role: "Runs the strip", labels: [], custom: {} },
} as unknown as BotView;

describe("BotRenameDialog", () => {
  it("seeds the record and submits the restyle", async () => {
    const onRename = vi.fn().mockResolvedValue(undefined);
    render(<BotRenameDialog bot={bot} onClose={() => {}} onRename={onRename} />);
    expect(screen.getByLabelText(/^Name/)).toHaveValue("Captain");
    expect(screen.getByLabelText(/^Role/)).toHaveValue("Runs the strip");
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: "Commodore" } });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    await waitFor(() => {
      expect(onRename).toHaveBeenCalledWith(bot, {
        name: "Commodore",
        iconUrl: "",
        role: "Runs the strip",
      });
    });
  });

  it("refuses an empty name and reports a failed rename in place", async () => {
    const onRename = vi.fn().mockRejectedValueOnce(new Error("a Bot named that already exists"));
    render(<BotRenameDialog bot={bot} onClose={() => {}} onRename={onRename} />);
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: "   " } });
    expect(screen.getByRole("button", { name: "Rename" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: "Taken" } });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("already exists");
    });
  });

  it("renders nothing when no Bot is being renamed", () => {
    render(<BotRenameDialog bot={null} onClose={() => {}} onRename={async () => {}} />);
    expect(screen.queryByRole("button", { name: "Rename" })).toBeNull();
  });
});
