import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { SessionSummary, StartedSourceSession } from "@agentdesk/agent-feed-wire";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import { StartedSessionModal } from "@/features/session-view/StartedSessionModal";

vi.mock("@/features/terminal/AgentTerminalPane", () => ({
  AgentTerminalPane: ({ context }: { context: { kind: string; session: string } }) => (
    <section aria-label="terminal">{`${context.kind}:${context.session}`}</section>
  ),
}));

const STARTED: StartedSourceSession = {
  source: "claude",
  sessionId: "11111111-1111-4111-8111-111111111111",
  title: "Garden notes",
  projectPath: "/Users/reader/projects/garden",
  tmuxSession: "garden-notes",
};
const LISTED = {
  source: "claude",
  sessionId: STARTED.sessionId,
  title: "Garden notes",
  lastEventAt: 5,
} as SessionSummary;

function modal(sessionsByProject: Map<string, SessionSummary[]>, onListed = vi.fn()) {
  const view = render(
    <StartedSessionModal
      feed={{} as SidecarDataSource}
      started={STARTED}
      projects={[]}
      sessionsByProject={sessionsByProject}
      onListed={onListed}
      onClose={vi.fn()}
    />,
  );
  return { ...view, onListed };
}

it("shows the pane the session was started in until the catalog lists it", () => {
  const { onListed } = modal(new Map());
  expect(screen.getByRole("dialog", { name: "Garden notes" })).toBeInTheDocument();
  expect(screen.getByLabelText("terminal")).toHaveTextContent("tmux:garden-notes");
  expect(onListed).not.toHaveBeenCalled();
});

it("hands itself over once the catalog lists the session, with a project for a new directory", () => {
  const onListed = vi.fn();
  const { rerender } = modal(new Map(), onListed);
  rerender(
    <StartedSessionModal
      feed={{} as SidecarDataSource}
      started={STARTED}
      projects={[]}
      sessionsByProject={new Map([[STARTED.projectPath, [LISTED]]])}
      onListed={onListed}
      onClose={vi.fn()}
    />,
  );
  expect(onListed).toHaveBeenCalledWith(
    expect.objectContaining({ projectPath: STARTED.projectPath, displayName: "garden" }),
    LISTED,
  );
});
