import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BotView, SessionSummary } from "@agentdesk/agent-feed-wire";
import type { BotRegistry } from "@/bots/botRegistry";
import { createBotRoutes } from "@/http/botRoutes";
import { RepositoryGitWatch } from "@/workspace/repositoryWatch";

const server = { timeout() {} } as never;
const repositories = new RepositoryGitWatch({ quietMs: 50, longestWaitMs: 200 });
const LIMITS = { maxTextBytes: 1024, maxDocumentBytes: 1024 };

async function git(cwd: string, ...args: string[]): Promise<void> {
  const run = Bun.spawn(["git", "-c", "user.name=test", "-c", "user.email=test@example.com", ...args], {
    cwd,
    stdout: "ignore",
    stderr: "ignore",
  });
  expect(await run.exited).toBe(0);
}

function session(sessionId: string, worktree?: SessionSummary["worktree"]): SessionSummary {
  return { sessionId, source: "claude", ...(worktree ? { worktree } : {}) } as SessionSummary;
}

test("reads the worktree a Bot's session works in when the request names that session", async () => {
  const top = await realpath(await mkdtemp(join(tmpdir(), "bot-worktree-route-")));
  const checkout = join(top, "checkout");
  const worktree = join(top, "feature");
  try {
    await Bun.spawn(["mkdir", checkout]).exited;
    await git(checkout, "init", "--initial-branch=main");
    await writeFile(join(checkout, "main.ts"), "main\n");
    await git(checkout, "add", "main.ts");
    await git(checkout, "commit", "-m", "init");
    await git(checkout, "worktree", "add", "-b", "feature", worktree);
    await writeFile(join(worktree, "feature.ts"), "feature work\n");
    const bot = {
      botId: "bot-1",
      name: "Chief",
      environment: { kind: "directory", path: checkout },
      environmentAvailability: "available",
      sessions: [session("in-worktree", { path: worktree, branch: "feature" }), session("in-checkout")],
    } as unknown as BotView;
    const registry = {
      async snapshot() {
        return { version: 2, revision: 1, bots: [bot] };
      },
    } as unknown as BotRegistry;
    const route = createBotRoutes(registry, repositories, LIMITS);
    const ask = async (path: string) => {
      const request = new Request(`http://localhost${path}`);
      return (await route(request, new URL(request.url), server))!;
    };
    // `.git` aside: the tree lists it in both, a directory in the checkout and a file in the worktree.
    const names = async (path: string) =>
      ((await (await ask(path)).json()) as { tree: { name: string }[] }).tree
        .map((node) => node.name)
        .filter((name) => name !== ".git");

    expect(await names("/api/bots/bot-1/tree?source=claude&session=in-worktree")).toEqual(["feature.ts", "main.ts"]);
    expect(await names("/api/bots/bot-1/tree?source=claude&session=in-checkout")).toEqual(["main.ts"]);
    expect(await names("/api/bots/bot-1/tree")).toEqual(["main.ts"]);
    const file = await ask("/api/bots/bot-1/file?path=feature.ts&source=claude&session=in-worktree");
    expect(((await file.json()) as { text: string }).text).toBe("feature work\n");
    expect((await ask("/api/bots/bot-1/file?path=feature.ts")).status).toBe(404);
    const diff = await ask("/api/bots/bot-1/git/diff?path=feature.ts&source=claude&session=in-worktree");
    expect(((await diff.json()) as { patch: string }).patch).toContain("+feature work");

    // A session the Bot does not hold is not a way to name some other folder, and half a name is
    // not a name.
    expect((await ask("/api/bots/bot-1/tree?source=claude&session=elsewhere")).status).toBe(404);
    expect((await ask("/api/bots/bot-1/tree?source=opencode&session=in-worktree")).status).toBe(404);
    expect((await ask("/api/bots/bot-1/tree?session=in-worktree")).status).toBe(400);
  } finally {
    await rm(top, { recursive: true, force: true });
  }
});
