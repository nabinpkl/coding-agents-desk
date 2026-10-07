import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ProjectSummary, SessionSummary } from "@agentdesk/agent-feed-wire";
import { SessionModal } from "@/features/session-view/SessionModal";
import type { SessionViewContext } from "@/features/session-view/sessionTerminalTypes";

// The modal's own chrome is the subject; the transcript inside it has suites of its own.
vi.mock("@/features/session-view/SessionView", () => ({ SessionView: () => <div data-testid="session-view" /> }));

const project = { projectPath: "/repo", displayName: "repo" } as ProjectSummary;
const session = { source: "claude", sessionId: "s-1", title: "Probe" } as SessionSummary;
const context = {} as SessionViewContext;

describe("SessionModal's Move to canvas", () => {
  it("is not offered when nothing is passed for it", () => {
    render(<SessionModal context={context} project={project} session={session} onClose={() => {}} />);
    expect(screen.queryByRole("button", { name: "Move to canvas" })).toBeNull();
  });

  it("closes once the session is on a Bot", async () => {
    const onClose = vi.fn();
    const onMoveToCanvas = vi.fn(async () => {});
    render(<SessionModal context={context} project={project} session={session} onClose={onClose} onMoveToCanvas={onMoveToCanvas} />);

    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Move to canvas" })));

    expect(onMoveToCanvas).toHaveBeenCalledWith(session);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("stays open and says why when the move fails, with the button usable again", async () => {
    const onClose = vi.fn();
    const onMoveToCanvas = vi.fn(async () => { throw new Error("a Bot named \"repo\" already exists"); });
    render(<SessionModal context={context} project={project} session={session} onClose={onClose} onMoveToCanvas={onMoveToCanvas} />);

    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Move to canvas" })));

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("already exists");
    expect(screen.getByRole("button", { name: "Move to canvas" })).not.toBeDisabled();
  });
});
