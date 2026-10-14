import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ProjectSummary, RecentSession } from "@agentdesk/agent-feed-wire";
import { CanvasSessionsList, type CanvasSessions } from "@/features/sidebar/CanvasSessionsList";

const desk: ProjectSummary = {
  projectPath: "/repo/agent-desk", displayName: "agent-desk", sourceCounts: { claude: 1 }, sessionCount: 1, lastEventAt: 2,
};
const oss: ProjectSummary = {
  projectPath: "/repo/oss-agent", displayName: "oss-agent", sourceCounts: { claude: 1 }, sessionCount: 1, lastEventAt: 3,
};
function row(sessionId: string, title: string, projectPath: string, lastEventAt: number): RecentSession {
  return { source: "claude", sessionId, title, lastEventAt, activity: "ready", projectPath } as RecentSession;
}

const list = {
  projects: [oss, desk],
  sessionsByProject: new Map(),
  loading: false,
  error: null,
  retrying: false,
  expandedProjectPaths: new Set<string>(),
  onToggleProject: () => {},
};

function sessions(overrides: Partial<CanvasSessions>): CanvasSessions {
  return {
    onOpen: () => {},
    canvasMove: { held: new Set(), onMove: () => {} },
    modalSelection: null,
    grouped: false,
    onGroupedChange: () => {},
    recent: null,
    onShowMore: () => {},
    onNewSession: () => {},
    ...overrides,
  };
}

describe("the Canvas tab's Sessions view", () => {
  it("lists sessions in the order the sidecar sent, each naming its project", () => {
    const recent = { recent: [row("b", "Brian", oss.projectPath, 3), row("a", "Alan", desk.projectPath, 2)], more: false };
    render(<CanvasSessionsList list={list} sessions={sessions({ recent })} />);

    const rows = within(screen.getByRole("list", { name: "Sessions, most recently changed first" }))
      .getAllByRole("button", { name: /^(Brian|Alan)/ });
    expect(rows.map((button) => button.textContent)).toEqual([
      expect.stringContaining("Brian"),
      expect.stringContaining("Alan"),
    ]);
    expect(rows[0]).toHaveTextContent("oss-agent");
    expect(rows[1]).toHaveTextContent("agent-desk");
    // No grouping, so nothing to unfold.
    expect(screen.queryByRole("list", { name: "Projects" })).toBeNull();
  });

  it("offers a new session in either view", () => {
    const onNewSession = vi.fn();
    const { rerender } = render(<CanvasSessionsList list={list} sessions={sessions({ onNewSession })} />);
    fireEvent.click(screen.getByRole("button", { name: "New session" }));
    rerender(<CanvasSessionsList list={list} sessions={sessions({ onNewSession, grouped: true })} />);
    fireEvent.click(screen.getByRole("button", { name: "New session" }));
    expect(onNewSession).toHaveBeenCalledTimes(2);
  });

  it("opens a row with the project it belongs to", () => {
    const onOpen = vi.fn();
    const brian = row("b", "Brian", oss.projectPath, 3);
    render(<CanvasSessionsList list={list} sessions={sessions({ onOpen, recent: { recent: [brian], more: false } })} />);

    fireEvent.click(screen.getByRole("button", { name: /^Brian/ }));

    expect(onOpen).toHaveBeenCalledWith(oss, brian);
  });

  it("asks for the next page only when the sidecar says there is one", () => {
    const onShowMore = vi.fn();
    const recent = { recent: [row("b", "Brian", oss.projectPath, 3)], more: true };
    const { rerender } = render(<CanvasSessionsList list={list} sessions={sessions({ recent, onShowMore })} />);

    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    expect(onShowMore).toHaveBeenCalledOnce();

    rerender(<CanvasSessionsList list={list} sessions={sessions({ recent: { ...recent, more: false }, onShowMore })} />);
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
  });

  it("says it is loading until the first page arrives, rather than saying there are none", () => {
    render(<CanvasSessionsList list={list} sessions={sessions({ recent: null })} />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading sessions");
  });

  it("switches between grouped and flat from its toggle", () => {
    const onGroupedChange = vi.fn();
    const { rerender } = render(<CanvasSessionsList list={list} sessions={sessions({ grouped: true, onGroupedChange })} />);

    const toggle = screen.getByRole("button", { name: "Group by project" });
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("list", { name: "Projects" })).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(onGroupedChange).toHaveBeenCalledWith(false);

    rerender(<CanvasSessionsList list={list} sessions={sessions({ grouped: false, onGroupedChange })} />);
    fireEvent.click(screen.getByRole("button", { name: "Group by project" }));
    expect(onGroupedChange).toHaveBeenLastCalledWith(true);
  });
});
