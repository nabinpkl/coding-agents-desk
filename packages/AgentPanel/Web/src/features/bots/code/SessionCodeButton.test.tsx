import { act, fireEvent, render, renderHook, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { expect, it, vi } from "vitest";
import type { BotTree, BotView, SessionSummary } from "@agentdesk/agent-feed-wire";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import { FilePathOpenerContext, type FilePathOpener } from "@/features/activity-feed/markdown/filePathLinks";
import { SessionCodeButton, SessionCodeDialog } from "@/features/bots/code/SessionCodeButton";
import { useSessionCode } from "@/features/bots/code/useSessionCode";

const bot = {
  botId: "bot-1",
  name: "Rags",
  environment: { kind: "directory", path: "/projects/rags" },
  environmentAvailability: "available",
} as BotView;

const inCheckout = { source: "claude", sessionId: "s-main", title: "Main" } as SessionSummary;
const inWorktree = {
  source: "claude",
  sessionId: "s-wt",
  title: "Feature",
  worktree: { path: "/projects/rags/.claude/worktrees/feature", branch: "feature" },
} as SessionSummary;

function fakeFeed() {
  const botTree = vi.fn(async (botId: string): Promise<BotTree> => ({ botId, tree: [] }));
  const subscribeBotGit = vi.fn((..._args: unknown[]) => () => {});
  const feed = { botTree, subscribeBotGit, botContentUrl: () => null } as unknown as SidecarDataSource;
  return { feed, botTree, subscribeBotGit };
}

function button(session: SessionSummary) {
  const onOpen = vi.fn();
  render(<SessionCodeButton bot={bot} session={session} onOpen={onOpen} />);
  return onOpen;
}

it("reads the Bot's directory for a session in it, with no session named", async () => {
  const { feed, botTree, subscribeBotGit } = fakeFeed();
  const onOpen = button(inCheckout);
  fireEvent.click(screen.getByRole("button", { name: "Browse the code for Main" }));
  expect(onOpen).toHaveBeenCalledOnce();

  render(<SessionCodeDialog bot={bot} feed={feed} session={inCheckout} file={null} onClose={vi.fn()} />);
  const dialog = await screen.findByRole("dialog", { name: "Rags" });
  expect(within(dialog).getByText("/projects/rags")).toBeTruthy();
  expect(botTree).toHaveBeenCalledWith("bot-1", []);
  expect(subscribeBotGit.mock.calls[0]?.[3]).toBeUndefined();
});

it("reads the worktree a session works in, naming the session for its files and its git", async () => {
  const { feed, botTree, subscribeBotGit } = fakeFeed();
  button(inWorktree);
  expect(screen.getByRole("button", { name: "Browse the code for Feature, in the feature worktree" })).toBeTruthy();

  render(<SessionCodeDialog bot={bot} feed={feed} session={inWorktree} file={null} onClose={vi.fn()} />);
  const dialog = await screen.findByRole("dialog", { name: "Rags · feature" });
  expect(within(dialog).getByText("/projects/rags/.claude/worktrees/feature")).toBeTruthy();
  const ref = { source: "claude", sessionId: "s-wt" };
  expect(botTree).toHaveBeenCalledWith("bot-1", [], ref);
  expect(subscribeBotGit.mock.calls[0]?.[3]).toEqual(ref);
});

it("is unavailable while the Bot's directory is missing", () => {
  render(
    <SessionCodeButton bot={{ ...bot, environmentAvailability: "missing" }} session={inCheckout} onOpen={vi.fn()} />,
  );
  expect(screen.getByRole("button", { name: "Browse the code for Main" })).toBeDisabled();
});

it("opens a worktree session's transcript paths in its own viewer, and leaves the rest to the Bot card", () => {
  const botOpener: FilePathOpener = { root: "/projects/rags", open: vi.fn() };
  const wrapper = ({ children }: { children: ReactNode }) => (
    <FilePathOpenerContext.Provider value={botOpener}>{children}</FilePathOpenerContext.Provider>
  );

  expect(renderHook(() => useSessionCode(inCheckout), { wrapper }).result.current.opener).toBe(botOpener);

  const { result } = renderHook(() => useSessionCode(inWorktree), { wrapper });
  expect(result.current.opener?.root).toBe("/projects/rags/.claude/worktrees/feature");
  expect(result.current.request).toBeNull();
  act(() => result.current.opener?.open({ path: "src/app.ts", line: 3 }));
  expect(result.current.request).toEqual({ file: { path: "src/app.ts", line: 3 } });
  expect(botOpener.open).not.toHaveBeenCalled();
  act(() => result.current.close());
  expect(result.current.request).toBeNull();
  act(() => result.current.openFolder());
  expect(result.current.request).toEqual({ file: null });
});
