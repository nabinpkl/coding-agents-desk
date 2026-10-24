import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { BotMachine } from "@/features/bots/botMachines";
import { ChatDraftDialog } from "@/features/bots/dialogs/ChatDraftDialog";

const MAC = { label: "mac", feed: {} } as unknown as BotMachine;
const ORACLE = { id: "oracle", label: "oracle", feed: {} } as unknown as BotMachine;

function field(): HTMLTextAreaElement {
  return screen.getByRole<HTMLTextAreaElement>("textbox", { name: "First message" });
}

describe("the Chat box", () => {
  it("opens on its message field with nothing to send", () => {
    render(<ChatDraftDialog machines={[MAC]} machine={MAC} onClose={() => {}} onStart={async () => {}} />);
    expect(field()).toHaveFocus();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });

  it("starts the chat with what was typed, on Enter", async () => {
    const onStart = vi.fn(async () => {});
    render(<ChatDraftDialog machines={[MAC]} machine={MAC} onClose={() => {}} onStart={onStart} />);
    fireEvent.change(field(), { target: { value: "Plan the garden" } });
    fireEvent.keyDown(field(), { key: "Enter" });
    await waitFor(() => expect(onStart).toHaveBeenCalledWith("Plan the garden", MAC));
  });

  it("keeps a line break for Shift+Enter instead of sending", () => {
    const onStart = vi.fn(async () => {});
    render(<ChatDraftDialog machines={[MAC]} machine={MAC} onClose={() => {}} onStart={onStart} />);
    fireEvent.change(field(), { target: { value: "first line" } });
    fireEvent.keyDown(field(), { key: "Enter", shiftKey: true });
    expect(onStart).not.toHaveBeenCalled();
  });

  it("keeps the message and says why when the chat could not start", async () => {
    render(
      <ChatDraftDialog
        machines={[MAC]}
        machine={MAC}
        onClose={() => {}}
        onStart={async () => {
          throw new Error("the sidecar is restarting");
        }}
      />,
    );
    fireEvent.change(field(), { target: { value: "Plan the garden" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("the sidecar is restarting");
    expect(field().value).toBe("Plan the garden");
    expect(field()).not.toBeDisabled();
  });

  it("closes on Escape without starting anything", () => {
    const onClose = vi.fn();
    const onStart = vi.fn(async () => {});
    render(<ChatDraftDialog machines={[MAC]} machine={MAC} onClose={onClose} onStart={onStart} />);
    fireEvent.change(field(), { target: { value: "never sent" } });
    fireEvent.keyDown(field(), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onStart).not.toHaveBeenCalled();
  });

  it("offers no machine choice while there is one machine", () => {
    render(<ChatDraftDialog machines={[MAC]} machine={MAC} onClose={() => {}} onStart={async () => {}} />);
    expect(screen.queryByRole("group", { name: "Machine" })).toBeNull();
  });

  it("starts on the panel's machine unless another is picked in the header", async () => {
    const onStart = vi.fn(async () => {});
    render(<ChatDraftDialog machines={[MAC, ORACLE]} machine={MAC} onClose={() => {}} onStart={onStart} />);
    const machines = screen.getByRole("group", { name: "Machine" });
    expect(within(machines).getByRole("button", { name: "mac" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(within(machines).getByRole("button", { name: "oracle" }));
    // Back to the message, so picking a machine costs no extra press before typing.
    expect(field()).toHaveFocus();
    fireEvent.change(field(), { target: { value: "Plan the garden" } });
    fireEvent.keyDown(field(), { key: "Enter" });
    await waitFor(() => expect(onStart).toHaveBeenCalledWith("Plan the garden", ORACLE));
  });
});
