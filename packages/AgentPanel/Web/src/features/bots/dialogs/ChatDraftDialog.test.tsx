import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ChatDraftDialog } from "@/features/bots/dialogs/ChatDraftDialog";

function field(): HTMLTextAreaElement {
  return screen.getByRole<HTMLTextAreaElement>("textbox", { name: "First message" });
}

describe("the Chat box", () => {
  it("opens on its message field with nothing to send", () => {
    render(<ChatDraftDialog onClose={() => {}} onStart={async () => {}} />);
    expect(field()).toHaveFocus();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });

  it("starts the chat with what was typed, on Enter", async () => {
    const onStart = vi.fn(async () => {});
    render(<ChatDraftDialog onClose={() => {}} onStart={onStart} />);
    fireEvent.change(field(), { target: { value: "Plan the garden" } });
    fireEvent.keyDown(field(), { key: "Enter" });
    await waitFor(() => expect(onStart).toHaveBeenCalledWith("Plan the garden"));
  });

  it("keeps a line break for Shift+Enter instead of sending", () => {
    const onStart = vi.fn(async () => {});
    render(<ChatDraftDialog onClose={() => {}} onStart={onStart} />);
    fireEvent.change(field(), { target: { value: "first line" } });
    fireEvent.keyDown(field(), { key: "Enter", shiftKey: true });
    expect(onStart).not.toHaveBeenCalled();
  });

  it("keeps the message and says why when the chat could not start", async () => {
    render(
      <ChatDraftDialog
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
    render(<ChatDraftDialog onClose={onClose} onStart={onStart} />);
    fireEvent.change(field(), { target: { value: "never sent" } });
    fireEvent.keyDown(field(), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onStart).not.toHaveBeenCalled();
  });
});
