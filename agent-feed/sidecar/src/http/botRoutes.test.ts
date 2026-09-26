import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BotView } from "@agentdesk/agent-feed-wire";
import { BotConflictError, type BotRegistry } from "@/bots/botRegistry";
import { createBotRoutes } from "@/http/botRoutes";
import { RepositoryGitWatch } from "@/workspace/repositoryWatch";

const server = { timeout() {} } as never;
const repositories = new RepositoryGitWatch({ quietMs: 50, longestWaitMs: 200 });
const LIMITS = { maxTextBytes: 64, maxDocumentBytes: 1024 };
const DEPENDENCIES = { renameSession: async () => {} };
const bot: BotView = {
  botId: "bot-1",
  name: "Chief of Staff",
  environment: { kind: "directory", path: "/projects/chief" },
  sessionRefs: [],
  metadata: { role: "Coordinates agents", labels: ["coordination"], custom: {} },
  grants: ["add_bot"],
  createdAt: 1,
  createdBy: { kind: "user" },
  environmentAvailability: "available",
  sessions: [],
  missingSessionRefs: [],
};

test("creates a Bot through the authenticated user route and returns its durable view", async () => {
  const calls: unknown[] = [];
  const registry = {
    async add(command: unknown, actor: unknown) {
      calls.push({ command, actor });
      return bot;
    },
  } as unknown as BotRegistry;
  const route = createBotRoutes(registry, repositories, LIMITS, DEPENDENCIES);
  const request = new Request("http://localhost/api/bots", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      requestId: "request-1",
      name: "Chief of Staff",
      directoryPath: "/projects/chief",
      grants: ["add_bot"],
    }),
  });

  const response = await route(request, new URL(request.url), server);

  expect(response?.status).toBe(201);
  expect(await response?.json()).toEqual(bot);
  expect(calls).toEqual([{
    command: {
      requestId: "request-1",
      name: "Chief of Staff",
      directoryPath: "/projects/chief",
      grants: ["add_bot"],
    },
    actor: { kind: "user" },
  }]);
});

test("adds sessions through the Bot-scoped route, existing or newly started", async () => {
  const calls: unknown[] = [];
  const registry = {
    async addSessions(botId: string, command: unknown, actor: unknown) {
      calls.push({ botId, command, actor });
      return { bot };
    },
  } as unknown as BotRegistry;
  const route = createBotRoutes(registry, repositories, LIMITS, DEPENDENCIES);
  const request = new Request("http://localhost/api/bots/bot-1/sessions", {
    method: "POST",
    body: JSON.stringify({
      requestId: "attach-1",
      sessionRefs: [{ source: "pi", sessionId: "pi-1" }],
    }),
  });

  const response = await route(request, new URL(request.url), server);

  expect(response?.status).toBe(200);
  // The envelope, not the Bot: this route can now start a session, and the caller has nowhere else
  // to read the pane it landed in from.
  expect(await response?.json()).toEqual({ bot });
  expect(calls).toEqual([{
    botId: "bot-1",
    command: {
      requestId: "attach-1",
      sessionRefs: [{ source: "pi", sessionId: "pi-1" }],
    },
    actor: { kind: "user" },
  }]);
});

test("maps registry conflicts to a typed 409 response", async () => {
  const registry = {
    async add() {
      throw new BotConflictError("selected session is already bound to a Bot");
    },
  } as unknown as BotRegistry;
  const route = createBotRoutes(registry, repositories, LIMITS, DEPENDENCIES);
  const request = new Request("http://localhost/api/bots", {
    method: "POST",
    body: JSON.stringify({ requestId: "request-1" }),
  });

  const response = await route(request, new URL(request.url), server);

  expect(response?.status).toBe(409);
  expect(await response?.json()).toEqual({
    error: {
      code: "bot-conflict",
      message: "selected session is already bound to a Bot",
      retryable: false,
    },
  });
});

test("detaches sessions through a POST route the host relay can reach", async () => {
  const calls: unknown[] = [];
  const registry = {
    async detachSessions(botId: string, command: unknown, actor: unknown) {
      calls.push({ botId, command, actor });
      return bot;
    },
    async attachSessions() {
      throw new Error("detach must not reach the attach path");
    },
  } as unknown as BotRegistry;
  const route = createBotRoutes(registry, repositories, LIMITS, DEPENDENCIES);
  // The relay admits GET and POST only, so removal is a POST to its own path rather than a DELETE
  // on the attach path. `/sessions` and `/sessions/detach` must therefore stay distinguishable.
  const request = new Request("http://localhost/api/bots/bot%201/sessions/detach", {
    method: "POST",
    body: JSON.stringify({
      requestId: "detach-1",
      sessionRefs: [{ source: "pi", sessionId: "pi-1" }],
    }),
  });

  const response = await route(request, new URL(request.url), server);

  expect(response?.status).toBe(200);
  expect(await response?.json()).toEqual(bot);
  expect(calls).toEqual([{
    botId: "bot 1",
    command: {
      requestId: "detach-1",
      sessionRefs: [{ source: "pi", sessionId: "pi-1" }],
    },
    actor: { kind: "user" },
  }]);
});

test("reorders sessions through a path of its own, so an order is never read as an attach", async () => {
  const calls: unknown[] = [];
  const registry = {
    async reorderSessions(botId: string, command: unknown, actor: unknown) {
      calls.push({ botId, command, actor });
      return bot;
    },
    async addSessions() {
      throw new Error("an order must not reach the attach path");
    },
    async detachSessions() {
      throw new Error("an order must not reach the detach path");
    },
  } as unknown as BotRegistry;
  const route = createBotRoutes(registry, repositories, LIMITS, DEPENDENCIES);
  const request = new Request("http://localhost/api/bots/bot%201/sessions/order", {
    method: "POST",
    body: JSON.stringify({
      requestId: "order-1",
      sessionRefs: [
        { source: "claude", sessionId: "claude-2" },
        { source: "pi", sessionId: "pi-1" },
      ],
    }),
  });

  const response = await route(request, new URL(request.url), server);

  expect(response?.status).toBe(200);
  expect(await response?.json()).toEqual(bot);
  expect(calls).toEqual([{
    botId: "bot 1",
    command: {
      requestId: "order-1",
      sessionRefs: [
        { source: "claude", sessionId: "claude-2" },
        { source: "pi", sessionId: "pi-1" },
      ],
    },
    actor: { kind: "user" },
  }]);
});

test("leaves a DELETE on the sessions path unmatched rather than answering it", async () => {
  const registry = {
    async detachSessions() {
      throw new Error("a DELETE must not reach the registry");
    },
  } as unknown as BotRegistry;
  const route = createBotRoutes(registry, repositories, LIMITS, DEPENDENCIES);
  const request = new Request("http://localhost/api/bots/bot-1/sessions", { method: "DELETE" });

  expect(await route(request, new URL(request.url), server)).toBeUndefined();
});

test("routes a retire to its own path and hands the disposals through untouched", async () => {
  const calls: unknown[] = [];
  const registry = {
    async retireSessions(botId: string, command: unknown, actor: unknown) {
      calls.push({ botId, command, actor });
      return { bot, retired: [{ source: "claude", sessionId: "c-1", endedPane: "agentdesk-c-1", failed: [] }] };
    },
    async detachSessions() {
      throw new Error("retire must not reach the detach path");
    },
  } as unknown as BotRegistry;
  const route = createBotRoutes(registry, repositories, LIMITS, DEPENDENCIES);
  // `/sessions`, `/sessions/detach` and `/sessions/retire` are three POSTs under one prefix, so the
  // thing worth asserting is that the deepest one does not fall into either of the others.
  const request = new Request("http://localhost/api/bots/bot%201/sessions/retire", {
    method: "POST",
    body: JSON.stringify({
      requestId: "retire-1",
      sessionRefs: [{ source: "claude", sessionId: "c-1" }],
      worktree: "remove",
      branch: "delete",
    }),
  });

  const response = await route(request, new URL(request.url), server);

  expect(response?.status).toBe(200);
  expect(await response?.json()).toEqual({
    bot,
    retired: [{ source: "claude", sessionId: "c-1", endedPane: "agentdesk-c-1", failed: [] }],
  });
  expect(calls).toEqual([{
    botId: "bot 1",
    command: {
      requestId: "retire-1",
      sessionRefs: [{ source: "claude", sessionId: "c-1" }],
      worktree: "remove",
      branch: "delete",
    },
    actor: { kind: "user" },
  }]);
});

/** Reads server-sent events off a streamed response until `accept` takes one, then cancels. */
async function nextEvent(response: Response | undefined, accept: (event: unknown) => boolean) {
  const reader = response!.body!.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error("stream ended");
      buffered += decoder.decode(value);
      for (const frame of buffered.split("\n\n")) {
        const data = frame.split("\n").find((line) => line.startsWith("data: "));
        if (!data) continue;
        const event: unknown = JSON.parse(data.slice(6));
        if (accept(event)) return event;
      }
    }
  } finally {
    await reader.cancel();
  }
}

test("renames one session's bracket through the registry, addressed by the session", async () => {
  const calls: unknown[] = [];
  const renamed = { botId: "bot-1", anchor: "Aaron", title: "Aaron (night shift)", status: "renamed" };
  const registry = {
    async renameBracket(ref: unknown, task: unknown, renamer: unknown) {
      calls.push({ ref, task, renamer });
      return renamed;
    },
  } as unknown as BotRegistry;
  const rename = async () => {};
  const route = createBotRoutes(registry, repositories, LIMITS, { renameSession: rename });
  const request = new Request("http://localhost/api/bots/sessions/rename-bracket", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source: "claude", sessionId: "session-1", task: "night shift" }),
  });

  const response = await route(request, new URL(request.url), server);
  expect(response?.status).toBe(200);
  expect(await response?.json()).toEqual(renamed);
  // The task text crosses; the anchor never does, and the route hands the renamer through.
  expect(calls).toEqual([{
    ref: { source: "claude", sessionId: "session-1" },
    task: "night shift",
    renamer: rename,
  }]);
});

test("refuses a bracket rename that names no task text", async () => {
  const registry = {
    async renameBracket() {
      throw new Error("unreached: validation is the route's");
    },
  } as unknown as BotRegistry;
  const route = createBotRoutes(registry, repositories, LIMITS, DEPENDENCIES);
  const request = new Request("http://localhost/api/bots/sessions/rename-bracket", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source: "claude", sessionId: "session-1" }),
  });

  const response = await route(request, new URL(request.url), server);
  expect(response?.status).toBe(400);
});

test("streams the Bot's directory's git status, from no repository to one", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bot-git-route-")));
  try {
    const registry = {
      async snapshot() {
        return { version: 2, revision: 1, bots: [{ ...bot, environment: { kind: "directory", path: root } }] };
      },
    } as unknown as BotRegistry;
    const route = createBotRoutes(registry, repositories, LIMITS, DEPENDENCIES);
    const stream = new Request("http://localhost/api/bots/bot-1/git/stream");
    const response = await route(stream, new URL(stream.url), server);
    expect(response?.headers.get("content-type")).toContain("text/event-stream");
    const reader = nextEvent(response, (event) =>
      (event as { entries: unknown[] }).entries.length > 0);

    await Bun.spawn(["git", "init", "--initial-branch=main"], { cwd: root, stdout: "ignore" }).exited;
    await writeFile(join(root, "new.ts"), "fresh\n");
    expect(await reader).toEqual({
      botId: "bot-1",
      repository: true,
      branch: "main",
      entries: [{ relativePath: "new.ts", indexStatus: "?", workTreeStatus: "?" }],
    });

    const diff = new Request("http://localhost/api/bots/bot-1/git/diff?path=new.ts");
    const answer = await route(diff, new URL(diff.url), server);
    expect(answer?.status).toBe(200);
    expect(((await answer?.json()) as { patch: string }).patch).toContain("+fresh");

    const unchanged = new Request("http://localhost/api/bots/bot-1/git/diff?path=other.ts");
    expect((await route(unchanged, new URL(unchanged.url), server))?.status).toBe(404);
    const unknown = new Request("http://localhost/api/bots/bot-2/git/stream");
    expect((await route(unknown, new URL(unknown.url), server))?.status).toBe(404);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reads a Bot's tree and files from its own directory, decorated from where it sits", async () => {
  const top = await realpath(await mkdtemp(join(tmpdir(), "bot-files-route-")));
  // The Bot is bound below the repository's top, so its paths and git's disagree by `app/`.
  const root = join(top, "app");
  try {
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "index.ts"), "export {};\n");
    await writeFile(join(root, "big.txt"), "x".repeat(100));
    await Bun.spawn(["git", "init", "--initial-branch=main"], { cwd: top, stdout: "ignore" }).exited;
    const registry = {
      async snapshot() {
        return { version: 2, revision: 1, bots: [{ ...bot, environment: { kind: "directory", path: root } }] };
      },
    } as unknown as BotRegistry;
    const route = createBotRoutes(registry, repositories, LIMITS, DEPENDENCIES);
    const ask = async (path: string) => {
      const request = new Request(`http://localhost${path}`);
      return (await route(request, new URL(request.url), server))!;
    };

    const collapsed = await (await ask("/api/bots/bot-1/tree")).json() as { tree: { name: string; children: unknown[]; gitStatus: string | null }[] };
    expect(collapsed.tree.map((node) => [node.name, node.gitStatus, node.children.length])).toEqual([
      ["src", "??", 0],
      ["big.txt", "??", 0],
    ]);
    const expanded = await (await ask("/api/bots/bot-1/tree?expanded=src")).json() as { tree: { children: { path: string }[] }[] };
    expect(expanded.tree[0]!.children.map((node) => node.path)).toEqual(["src/index.ts"]);

    expect(await (await ask("/api/bots/bot-1/file?path=src/index.ts")).json()).toEqual({
      botId: "bot-1",
      path: "src/index.ts",
      kind: "text",
      text: "export {};\n",
    });
    expect((await ask("/api/bots/bot-1/file?path=big.txt")).status).toBe(422);
    expect((await ask("/api/bots/bot-1/file?path=gone.ts")).status).toBe(404);
    expect((await ask("/api/bots/bot-1/file?path=../escape.ts")).status).toBeGreaterThanOrEqual(400);
    expect((await ask("/api/bots/bot-1/file")).status).toBe(400);
  } finally {
    await rm(top, { recursive: true, force: true });
  }
});
