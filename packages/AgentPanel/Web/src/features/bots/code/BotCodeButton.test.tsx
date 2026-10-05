import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { BotFileRead, BotGitStatus, BotTree, BotView, WorkspaceTreeNode } from "@agentdesk/agent-feed-wire";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import { BotCodeButton } from "@/features/bots/code/BotCodeButton";
import { BotCodeDialog } from "@/features/bots/code/BotCodeDialog";

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
  nextAnchor: "Adam",
};

const NO_GIT = { status: null, error: null };

/** A clean status, distinct per `n` so each one reads as a new push. */
function clean(n: number): BotGitStatus {
  return { botId: "bot-1", repository: true, branch: `main-${n}`, entries: [] };
}

function node(path: string, isDirectory: boolean, children: WorkspaceTreeNode[] = []): WorkspaceTreeNode {
  return {
    name: path.split("/").at(-1)!,
    path,
    isDirectory,
    expanded: children.length > 0,
    gitStatus: null,
    modifiedAt: 1_700_000_000_000,
    children,
  };
}

/** A sidecar holding `src/app.ts` and `README.md`, answering the tree for whatever is expanded. */
function feedWithFiles(texts: Record<string, string>) {
  const botTree = vi.fn(async (botId: string, expanded: readonly string[]): Promise<BotTree> => ({
    botId,
    tree: [
      node("src", true, expanded.includes("src") ? [node("src/app.ts", false)] : []),
      node("README.md", false),
    ],
  }));
  const botFile = vi.fn(async (botId: string, path: string): Promise<BotFileRead> => ({
    botId,
    path,
    kind: path.endsWith(".md") ? "markdown" : "text",
    revision: `revision of ${path}`,
    text: texts[path] ?? "",
  }));
  const botContentUrl = (botId: string, path: string) => `fake:/api/bots/${botId}/content?path=${path}`;
  return { feed: { botTree, botFile, botContentUrl } as unknown as SidecarDataSource, botTree, botFile };
}

it("opens a tree of the Bot's files and reads the one chosen, read-only", async () => {
  const { feed, botTree, botFile } = feedWithFiles({ "src/app.ts": "export const answer = 42;\n" });
  render(<BotCodeButton bot={bot} feed={feed} git={NO_GIT} />);

  fireEvent.click(screen.getByRole("button", { name: "Browse the code in Rags" }));
  const dialog = await screen.findByRole("dialog", { name: "Rags" });
  const files = within(dialog).getByRole("navigation", { name: "Files" });

  fireEvent.click(await within(files).findByRole("button", { name: "Expand src" }));
  fireEvent.click(await within(files).findByRole("button", { name: "Open app.ts" }));
  expect(botTree).toHaveBeenLastCalledWith("bot-1", ["src"]);

  const source = await within(dialog).findByRole("textbox", { name: "Source of app.ts" });
  expect((source as HTMLTextAreaElement).value).toBe("export const answer = 42;\n");
  expect((source as HTMLTextAreaElement).readOnly).toBe(true);
  expect(botFile).toHaveBeenCalledWith("bot-1", "src/app.ts");

  fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("renders markdown first, and offers its source", async () => {
  const { feed } = feedWithFiles({ "README.md": "# Rags\n\nRetrieval.\n" });
  render(<BotCodeButton bot={bot} feed={feed} git={NO_GIT} />);
  fireEvent.click(screen.getByRole("button", { name: "Browse the code in Rags" }));
  const dialog = await screen.findByRole("dialog", { name: "Rags" });

  fireEvent.click(await within(dialog).findByRole("button", { name: "Open README.md" }));
  expect(await within(dialog).findByRole("heading", { name: "Rags" })).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "Show file source" }));
  expect(await within(dialog).findByRole("textbox", { name: "Source of README.md" })).toBeTruthy();
});

it("reads the open file again when the Bot's files move", async () => {
  const texts = { "src/app.ts": "one\n" };
  const { feed, botFile } = feedWithFiles(texts);
  const { rerender } = render(<BotCodeButton bot={bot} feed={feed} git={{ status: clean(1), error: null }} />);
  fireEvent.click(screen.getByRole("button", { name: "Browse the code in Rags" }));
  const dialog = await screen.findByRole("dialog", { name: "Rags" });
  fireEvent.click(await within(dialog).findByRole("button", { name: "Expand src" }));
  fireEvent.click(await within(dialog).findByRole("button", { name: "Open app.ts" }));
  await within(dialog).findByDisplayValue("one");

  texts["src/app.ts"] = "two\n";
  rerender(<BotCodeButton bot={bot} feed={feed} git={{ status: clean(2), error: null }} />);
  await waitFor(() => expect(within(dialog).getByRole("textbox", { name: "Source of app.ts" })).toHaveProperty("value", "two\n"));
  expect(botFile).toHaveBeenCalledTimes(2);
});

it("is disabled, and says why, for a Bot whose directory is missing", () => {
  const { feed } = feedWithFiles({});
  render(<BotCodeButton bot={{ ...bot, environmentAvailability: "missing" }} feed={feed} git={NO_GIT} />);
  const button = screen.getByRole("button", { name: "Browse the code in Rags" });
  expect((button as HTMLButtonElement).disabled).toBe(true);
  expect(button.getAttribute("title")).toBe("Bot directory is unavailable");
});

it("opens on the changes from the git side, and moves between a diff, its file and the tree", async () => {
  const { feed, botFile } = feedWithFiles({ "src/app.ts": "now\n" });
  const botGitDiff = vi.fn(async (botId: string, path: string) => ({
    botId,
    path,
    patch: "diff --git a/src/app.ts b/src/app.ts\n@@ -1 +1 @@\n-then\n+now\n",
    truncated: false,
  }));
  Object.assign(feed, { botGitDiff });
  const git = {
    status: {
      botId: "bot-1",
      repository: true,
      branch: "main",
      entries: [{ relativePath: "src/app.ts", indexStatus: null, workTreeStatus: "M" }],
    },
    error: null,
  };
  render(<BotCodeDialog bot={bot} feed={feed} git={git} initialSection="sourceControl" onClose={() => {}} />);
  const dialog = await screen.findByRole("dialog", { name: "Rags" });

  expect(within(dialog).getByRole("button", { name: "Show Source Control, 1 changed file" }).getAttribute("aria-pressed"))
    .toBe("true");
  const changes = within(dialog).getByRole("navigation", { name: "Changed files" });
  fireEvent.click(within(changes).getByRole("button", { name: "Show the diff of src/app.ts" }));
  await waitFor(() => expect(within(dialog).getByLabelText("Diff of src/app.ts").textContent).toContain("now"));

  fireEvent.click(within(dialog).getByRole("button", { name: "Open src/app.ts" }));
  expect(await within(dialog).findByRole("textbox", { name: "Source of app.ts" })).toHaveProperty("value", "now\n");
  expect(botFile).toHaveBeenCalledWith("bot-1", "src/app.ts");

  fireEvent.click(within(dialog).getByRole("button", { name: "Show Explorer" }));
  expect(await within(dialog).findByRole("button", { name: "Expand src" })).toBeTruthy();
});

it("offers no Source Control tab outside a repository", async () => {
  const { feed } = feedWithFiles({});
  const git = { status: { botId: "bot-1", repository: false, branch: null, entries: [] }, error: null };
  render(<BotCodeDialog bot={bot} feed={feed} git={git} initialSection="sourceControl" onClose={() => {}} />);
  const dialog = await screen.findByRole("dialog", { name: "Rags" });
  expect((within(dialog).getByRole("button", { name: "Show Source Control" }) as HTMLButtonElement).disabled).toBe(true);
  expect(within(dialog).getByRole("button", { name: "Show Explorer" }).getAttribute("aria-pressed")).toBe("true");
});
