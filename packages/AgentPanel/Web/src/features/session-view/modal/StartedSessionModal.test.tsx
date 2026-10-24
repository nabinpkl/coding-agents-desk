import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { SessionSummary } from "@agentdesk/agent-feed-wire";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import { StartedSessionModal, type StartedNewSession } from "@/features/session-view/modal/StartedSessionModal";
import type { SessionViewContext } from "@/features/session-view/sessionTerminalTypes";

vi.mock("@/features/terminal/AgentTerminalPane", () => ({
  AgentTerminalPane: ({ context }: { context: { kind: string; session: string } }) => (
    <section aria-label="terminal">{`${context.kind}:${context.session}`}</section>
  ),
}));
vi.mock("@/features/session-view/modal/SessionModal", () => ({
  SessionModal: ({ session, listed }: { session: SessionSummary; listed: boolean }) => (
    <section aria-label="session view">{`${session.sessionId} listed:${listed}`}</section>
  ),
}));

const STARTED: StartedNewSession = {
  source: "claude",
  sessionId: "11111111-1111-4111-8111-111111111111",
  title: "Garden notes",
  projectPath: "/Users/reader/projects/garden",
  tmuxSession: "garden-notes",
  sdk: false,
};
const LISTED = {
  source: "claude",
  sessionId: STARTED.sessionId,
  title: "Garden notes",
  lastEventAt: 5,
} as SessionSummary;

function modal(sessionsByProject: Map<string, SessionSummary[]>, onListed = vi.fn(), started = STARTED) {
  const view = render(
    <StartedSessionModal
      feed={{} as SidecarDataSource}
      context={{} as SessionViewContext}
      started={started}
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
      context={{} as SessionViewContext}
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

it("opens an SDK session in its session view, unlisted, and never shows the runner's pane", () => {
  const sdk = { ...STARTED, sdk: true };
  const { onListed } = modal(new Map(), vi.fn(), sdk);
  expect(screen.getByLabelText("session view")).toHaveTextContent(`${STARTED.sessionId} listed:false`);
  expect(screen.queryByLabelText("terminal")).toBeNull();
  expect(onListed).not.toHaveBeenCalled();
});

it("hands an SDK session over the same way once the catalog lists it", () => {
  const onListed = vi.fn();
  modal(new Map([[STARTED.projectPath, [LISTED]]]), onListed, { ...STARTED, sdk: true });
  expect(onListed).toHaveBeenCalledWith(expect.objectContaining({ projectPath: STARTED.projectPath }), LISTED);
});

it("hands it over under the name it was started with when the catalog lists it before it is named", () => {
  const onListed = vi.fn();
  // A row with no name is titled with the session's id.
  modal(new Map([[STARTED.projectPath, [{ ...LISTED, title: STARTED.sessionId }]]]), onListed);
  expect(onListed).toHaveBeenCalledWith(expect.objectContaining({ projectPath: STARTED.projectPath }), {
    ...LISTED,
    title: "Garden notes",
  });
});
