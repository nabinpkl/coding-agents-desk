import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { BotGitStatus, BotView } from "@agentdesk/agent-feed-wire";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import { BotGitButton } from "@/features/bots/git/BotGitButton";

const bot: BotView = {
  botId: "bot-1",
  name: "Rags",
  environment: { kind: "directory", path: "/projects/rags" },
  sessionRefs: [],
  metadata: { labels: [], custom: {} },
  grants: [],
  createdAt: 1,
  createdBy: { kind: "user" },
  environmentAvailability: "available",
  sessions: [],
  missingSessionRefs: [],
};

function feedAnswering(status: BotGitStatus) {
  const botGitDiff = vi.fn(async (botId: string, path: string) => ({
    botId,
    path,
    patch: "diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-old line\n+new line\n",
    truncated: false,
  }));
  const feed = {
    botGitStatus: vi.fn(async () => status),
    botGitDiff,
  } as unknown as SidecarDataSource;
  return { feed, botGitDiff };
}

it("counts the changed files and opens them as a list and a diff", async () => {
  const { feed, botGitDiff } = feedAnswering({
    botId: "bot-1",
    repository: true,
    branch: "main",
    entries: [
      { relativePath: "src/a.ts", indexStatus: null, workTreeStatus: "M" },
      { relativePath: "notes.md", indexStatus: "?", workTreeStatus: "?" },
    ],
  });
  render(<BotGitButton bot={bot} feed={feed} />);

  const button = await screen.findByRole("button", { name: "Show git changes in Rags, 2 changed files" });
  expect(button.textContent).toBe("2");
  fireEvent.click(button);

  const dialog = await screen.findByRole("dialog", { name: "Changes in Rags" });
  const files = within(dialog).getByRole("navigation", { name: "Changed files" });
  fireEvent.click(within(files).getByRole("button", { name: "Open src/a.ts" }));

  await waitFor(() => expect(within(dialog).getByLabelText("Diff of src/a.ts")).toBeTruthy());
  expect(within(dialog).getByLabelText("Diff of src/a.ts").textContent).toContain("new line");
  expect(botGitDiff).toHaveBeenCalledWith("bot-1", "src/a.ts");
  expect(within(files).getByRole("button", { name: "Open src/a.ts" }).getAttribute("aria-current"))
    .toBe("true");

  fireEvent.click(within(dialog).getByRole("button", { name: "Close changes" }));
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("draws nothing for a directory that is not in a repository", async () => {
  const { feed } = feedAnswering({ botId: "bot-1", repository: false, branch: null, entries: [] });
  const { container } = render(<BotGitButton bot={bot} feed={feed} />);
  await waitFor(() => expect(feed.botGitStatus).toHaveBeenCalled());
  await Promise.resolve();
  expect(container.innerHTML).toBe("");
});

it("says why when git cannot be read, instead of showing a zero", async () => {
  const feed = {
    botGitStatus: vi.fn(async () => {
      throw new Error("the sidecar answered 500");
    }),
  } as unknown as SidecarDataSource;
  render(<BotGitButton bot={bot} feed={feed} />);
  expect(await screen.findByRole("img", { name: "Git changes unavailable: the sidecar answered 500" }))
    .toBeTruthy();
});

it("asks nothing for a Bot whose directory is missing", () => {
  const { feed } = feedAnswering({ botId: "bot-1", repository: true, branch: "main", entries: [] });
  const { container } = render(
    <BotGitButton bot={{ ...bot, environmentAvailability: "missing" }} feed={feed} />,
  );
  expect(feed.botGitStatus).not.toHaveBeenCalled();
  expect(container.innerHTML).toBe("");
});
