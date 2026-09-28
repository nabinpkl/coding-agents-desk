import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { HandoverDialog, type HandoverRequest } from "@/features/bots/dialogs/HandoverDialog";
import type { SessionSummary } from "@agentdesk/agent-feed-wire";

const REQUEST: HandoverRequest = {
  botId: "bot-1",
  session: { source: "claude", sessionId: "sid-1", title: "Handover driver" } as SessionSummary,
  projectPath: "/repo",
};

describe("HandoverDialog", () => {
  it("sends the typed message with the request", async () => {
    const onHandover = vi.fn(async () => {});
    render(<HandoverDialog request={REQUEST} onClose={() => {}} onHandover={onHandover} />);

    fireEvent.change(screen.getByPlaceholderText("What should it do first?"), { target: { value: "go on" } });
    fireEvent.click(screen.getByRole("button", { name: "Hand over" }));
    expect(onHandover).toHaveBeenCalledWith(REQUEST, "go on");
  });

  it("sends without a message when the field is left empty", async () => {
    const onHandover = vi.fn(async () => {});
    render(<HandoverDialog request={REQUEST} onClose={() => {}} onHandover={onHandover} />);

    fireEvent.click(screen.getByRole("button", { name: "Hand over" }));
    expect(onHandover).toHaveBeenCalledWith(REQUEST, "");
  });

  it("closes without sending", () => {
    const onClose = vi.fn();
    const onHandover = vi.fn(async () => {});
    render(<HandoverDialog request={REQUEST} onClose={onClose} onHandover={onHandover} />);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalled();
    expect(onHandover).not.toHaveBeenCalled();
  });

  it("names the harness the context is going to, in both directions", () => {
    // The dialog is the last thing a reader sees before a session starts somewhere, so a title
    // naming the wrong harness is the one wrong word that cannot be caught afterwards.
    const { unmount } = render(<HandoverDialog request={REQUEST} onClose={() => {}} onHandover={async () => {}} />);
    expect(screen.getByRole("heading", { name: "Hand over to opencode" })).toBeTruthy();
    unmount();

    const back: HandoverRequest = {
      ...REQUEST,
      session: { source: "opencode", sessionId: "oc-1", title: "Handover driver" } as SessionSummary,
    };
    render(<HandoverDialog request={back} onClose={() => {}} onHandover={async () => {}} />);
    expect(screen.getByRole("heading", { name: "Hand over to Claude" })).toBeTruthy();
  });

  it("renders nothing for a session with nowhere to go", () => {
    const codex: HandoverRequest = {
      ...REQUEST,
      session: { source: "codex", sessionId: "cx-1", title: "no boundary" } as SessionSummary,
    };
    const { container } = render(<HandoverDialog request={codex} onClose={() => {}} onHandover={async () => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing without a request", () => {
    render(<HandoverDialog request={null} onClose={() => {}} onHandover={async () => {}} />);
    expect(screen.queryByRole("button", { name: "Hand over" })).toBeNull();
  });
});
