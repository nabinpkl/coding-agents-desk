import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CSSProperties } from "react";
import type { BotView, ProjectSummary, SessionSummary } from "@agentdesk/agent-feed-wire";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import { SessionModal } from "@/features/session-view/SessionModal";
import { setBotFaces } from "@/features/bots/avatar/botFacesSwitch";
import type { SessionViewContext } from "@/features/session-view/sessionTerminalTypes";

// The modal's own chrome is the subject; the transcript inside it has suites of its own.
// Captures what the session was handed, which is how a fork from a message is checked.
const viewProps = vi.hoisted(() => ({ current: null as null | Record<string, unknown> }));
vi.mock("@/features/session-view/SessionView", () => ({
  SessionView: (props: Record<string, unknown>) => {
    viewProps.current = props;
    return <div data-testid="session-view" />;
  },
}));

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
    render(
      <SessionModal
        context={context}
        project={project}
        session={session}
        onClose={onClose}
        onMoveToCanvas={onMoveToCanvas}
      />,
    );

    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Move to canvas" })));

    expect(onMoveToCanvas).toHaveBeenCalledWith(session);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("stays open and says why when the move fails, with the button usable again", async () => {
    const onClose = vi.fn();
    const onMoveToCanvas = vi.fn(async () => {
      throw new Error('a Bot named "repo" already exists');
    });
    render(
      <SessionModal
        context={context}
        project={project}
        session={session}
        onClose={onClose}
        onMoveToCanvas={onMoveToCanvas}
      />,
    );

    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Move to canvas" })));

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("already exists");
    expect(screen.getByRole("button", { name: "Move to canvas" })).not.toBeDisabled();
  });
});

describe("SessionModal for a Bot's session", () => {
  it("names the Bot on a fork from its transcript, so the fork lands on that Bot", () => {
    const onForkFromFeed = vi.fn();
    const withFork = { onForkFromFeed } as unknown as SessionViewContext;
    render(<SessionModal context={withFork} project={project} session={session} onClose={() => {}} botId="bot-1" />);

    (viewProps.current!.onForkFromFeed as (request: object) => void)({ index: 4 });

    expect(onForkFromFeed).toHaveBeenCalledWith({ index: 4, botId: "bot-1" });
  });
});

describe("SessionModal's header face", () => {
  beforeEach(() => {
    localStorage.clear();
    setBotFaces(true);
  });

  it("opens with a Bot's session's face, ringed while live and with its eyes open", () => {
    const face = { style: { "--bot-hue": "200" } as CSSProperties, rank: 0, open: false };
    render(
      <SessionModal
        context={context}
        project={project}
        session={session}
        onClose={() => {}}
        mark={{ face, activity: "live" }}
      />,
    );
    const header = screen.getByRole("dialog").querySelector("header")!;
    const drawn = header.querySelector(".bot-face")!;
    expect(drawn.getAttribute("class")).toContain("ring-green-500");
    expect(drawn.querySelector(".bot-face-eyes--shut")).toBeNull();
  });

  it("opens with the title alone for a session no Bot holds", () => {
    render(<SessionModal context={context} project={project} session={session} onClose={() => {}} />);
    expect(screen.getByRole("dialog").querySelector("header .bot-face")).toBeNull();
  });
});

describe("SessionModal's code button", () => {
  const bot = {
    botId: "bot-1",
    name: "Rags",
    environment: { kind: "directory", path: "/projects/rags" },
    environmentAvailability: "available",
  } as BotView;
  // The Bot's record of the session, which is the one that knows its worktree.
  const held = { ...session, worktree: { path: "/projects/rags-feature", branch: "feature" } } as SessionSummary;

  it("is absent for a session no Bot holds", () => {
    render(<SessionModal context={context} project={project} session={session} onClose={() => {}} />);
    expect(screen.queryByRole("button", { name: /^Browse the code/ })).toBeNull();
  });

  it("opens the worktree a Bot's session works in, from the Bot's machine", async () => {
    const botTree = vi.fn(async (botId: string) => ({ botId, tree: [] }));
    const feed = {
      botTree,
      subscribeBotGit: vi.fn(() => () => {}),
      botContentUrl: () => null,
    } as unknown as SidecarDataSource;
    render(
      <SessionModal
        context={context}
        project={project}
        session={session}
        onClose={() => {}}
        code={{ bot, session: held, feed }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Browse the code for Probe, in the feature worktree" }));
    expect(await screen.findByRole("dialog", { name: "Rags · feature" })).toBeTruthy();
    expect(botTree).toHaveBeenCalledWith("bot-1", [], { source: "claude", sessionId: "s-1" });
  });
});
