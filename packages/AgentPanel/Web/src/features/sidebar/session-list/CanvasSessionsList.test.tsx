import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectSummary, RecentSession, RecentSessionsPayload } from "@agentdesk/agent-feed-wire";
import type { CSSProperties } from "react";
import { CanvasSessionsList, type CanvasSessions } from "@/features/sidebar/session-list/CanvasSessionsList";
import { setBotFaces } from "@/features/bots/avatar/botFacesSwitch";

const desk: ProjectSummary = {
  projectPath: "/repo/agent-desk",
  displayName: "agent-desk",
  sourceCounts: { claude: 1 },
  sessionCount: 1,
  lastEventAt: 2,
};
const oss: ProjectSummary = {
  projectPath: "/repo/oss-agent",
  displayName: "oss-agent",
  sourceCounts: { claude: 1 },
  sessionCount: 1,
  lastEventAt: 3,
};
function row(sessionId: string, title: string, projectPath: string, lastEventAt: number): RecentSession {
  return { source: "claude", sessionId, title, lastEventAt, activity: "ready", projectPath } as RecentSession;
}
const NO_REVIEWS: RecentSessionsPayload["securityReviews"] = { count: 0, live: 0, recent: [], more: false };

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
    faces: new Map(),
    modalSelection: null,
    grouped: false,
    onGroupedChange: () => {},
    recent: null,
    onShowMore: () => {},
    reconnecting: false,
    reviews: { open: false, onToggle: () => {}, onShowMore: () => {} },
    onNewSession: () => {},
    onNewChat: () => {},
    ...overrides,
  };
}

describe("the Canvas tab's Sessions view", () => {
  it("lists sessions in the order the sidecar sent, each naming its project", () => {
    const recent = {
      recent: [row("b", "Brian", oss.projectPath, 3), row("a", "Alan", desk.projectPath, 2)],
      more: false,
      securityReviews: NO_REVIEWS,
    };
    render(<CanvasSessionsList list={list} sessions={sessions({ recent })} />);

    const rows = within(screen.getByRole("list", { name: "Sessions, most recently changed first" })).getAllByRole(
      "button",
      { name: /^(Brian|Alan)/ },
    );
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

  it("offers a chat from the menu beside New", () => {
    const onNewChat = vi.fn();
    render(<CanvasSessionsList list={list} sessions={sessions({ onNewChat })} />);
    fireEvent.click(screen.getByRole("button", { name: "Actions for new sessions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Chat" }));
    expect(onNewChat).toHaveBeenCalledTimes(1);
  });

  it("folds scratch chats into one group, each named by its own folder", () => {
    const chat: ProjectSummary = {
      projectPath: "/scratch/plan-the-garden-1a2b",
      displayName: "Scratch",
      sourceCounts: { claude: 1 },
      sessionCount: 1,
      lastEventAt: 4,
      scratch: true,
    };
    render(
      <CanvasSessionsList list={{ ...list, projects: [chat, oss, desk] }} sessions={sessions({ grouped: true })} />,
    );

    const projects = screen.getByRole("list", { name: "Projects" });
    expect(within(projects).queryByText("Scratch")).toBeNull();
    expect(within(projects).getByText("oss-agent")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Scratch (1)" }));
    expect(
      within(screen.getByRole("list", { name: "Scratch chats" })).getByText("plan-the-garden-1a2b"),
    ).toBeInTheDocument();
  });

  it("opens a row with the project it belongs to", () => {
    const onOpen = vi.fn();
    const brian = row("b", "Brian", oss.projectPath, 3);
    render(
      <CanvasSessionsList
        list={list}
        sessions={sessions({ onOpen, recent: { recent: [brian], more: false, securityReviews: NO_REVIEWS } })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /^Brian/ }));

    expect(onOpen).toHaveBeenCalledWith(oss, brian);
  });

  it("asks for the next page only when the sidecar says there is one", () => {
    const onShowMore = vi.fn();
    const recent = { recent: [row("b", "Brian", oss.projectPath, 3)], more: true, securityReviews: NO_REVIEWS };
    const { rerender } = render(<CanvasSessionsList list={list} sessions={sessions({ recent, onShowMore })} />);

    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    expect(onShowMore).toHaveBeenCalledOnce();

    rerender(
      <CanvasSessionsList list={list} sessions={sessions({ recent: { ...recent, more: false }, onShowMore })} />,
    );
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
  });

  it("folds the security reviews into one row at the bottom, and asks for them only when it opens", () => {
    const onToggle = vi.fn();
    const onShowMore = vi.fn();
    const review = {
      ...row("r", "BotFace security review", desk.projectPath, 4),
      automation: "security-review" as const,
    };
    const recent = {
      recent: [row("b", "Brian", oss.projectPath, 3)],
      more: false,
      securityReviews: { count: 40, live: 2, recent: [], more: true },
    };
    const { rerender } = render(
      <CanvasSessionsList
        list={list}
        sessions={sessions({ recent, reviews: { open: false, onToggle, onShowMore } })}
      />,
    );

    const fold = screen.getByRole("button", { name: /Security reviews \(40\)/ });
    expect(fold).toHaveAttribute("aria-expanded", "false");
    expect(fold).toHaveTextContent("2 running");
    expect(screen.queryByRole("button", { name: /BotFace/ })).toBeNull();
    fireEvent.click(fold);
    expect(onToggle).toHaveBeenCalledOnce();

    rerender(
      <CanvasSessionsList
        list={list}
        sessions={sessions({
          recent: { ...recent, securityReviews: { ...recent.securityReviews, recent: [review] } },
          reviews: { open: true, onToggle, onShowMore },
        })}
      />,
    );
    const reviews = screen.getByRole("list", { name: "Security reviews, most recently changed first" });
    expect(within(reviews).getByRole("button", { name: /^BotFace security review/ })).toHaveTextContent("agent-desk");
    // The person's list says nothing more is behind it; the fold's own page does.
    const more = screen.getAllByRole("button", { name: "Show more" });
    expect(more).toHaveLength(1);
    fireEvent.click(more[0]!);
    expect(onShowMore).toHaveBeenCalledOnce();
  });

  it("says it is loading until the first page arrives, rather than saying there are none", () => {
    render(<CanvasSessionsList list={list} sessions={sessions({ recent: null })} />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading sessions");
  });

  it("switches between grouped and flat from its toggle", () => {
    const onGroupedChange = vi.fn();
    const { rerender } = render(
      <CanvasSessionsList list={list} sessions={sessions({ grouped: true, onGroupedChange })} />,
    );

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

describe("a Bot's session in the Sessions view", () => {
  beforeEach(() => {
    localStorage.clear();
    setBotFaces(true);
  });

  // Alice is a Bot's live session on the canvas, folded; Brian belongs to no Bot.
  const alice = { ...row("a", "Alice", desk.projectPath, 4), activity: "live" } as RecentSession;
  const brian = row("b", "Brian", oss.projectPath, 3);
  const faces = new Map([["claude:a", { style: { "--bot-hue": "200" } as CSSProperties, rank: 0, open: false }]]);

  it("wears its face, ringed while live, where another session keeps the dot", () => {
    const recent = { recent: [alice, brian], more: false, securityReviews: NO_REVIEWS };
    render(<CanvasSessionsList list={list} sessions={sessions({ recent, faces })} />);

    const face = screen.getByRole("button", { name: /^Alice/ }).querySelector(".bot-face")!;
    expect(face.getAttribute("class")).toContain("ring-green-500");
    expect(face.querySelector(".bot-face-eyes--shut")).not.toBeNull();
    // The Bot's colour reaches the face and stops there.
    expect(face.closest("[style]")).toHaveStyle({ "--bot-hue": "200" });
    expect(screen.getByRole("button", { name: /^Alice/ })).not.toHaveAttribute("style");

    const plain = screen.getByRole("button", { name: /^Brian/ });
    expect(plain.querySelector(".bot-face")).toBeNull();
    expect(plain.querySelector(".bg-muted-foreground\\/35")).not.toBeNull();
  });

  it("wears it in the grouped view too", () => {
    render(
      <CanvasSessionsList
        list={{
          ...list,
          expandedProjectPaths: new Set([desk.projectPath]),
          sessionsByProject: new Map([[desk.projectPath, [alice]]]),
        }}
        sessions={sessions({ grouped: true, faces })}
      />,
    );
    expect(screen.getByRole("button", { name: /^Alice/ }).querySelector(".bot-face")).not.toBeNull();
  });
});
