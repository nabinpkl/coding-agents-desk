import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BotView } from "@agentdesk/agent-feed-wire";
import { BotConflictError, type BotRegistry } from "@/bots/botRegistry";
import { createBotRoutes } from "@/http/botRoutes";

const server = { timeout() {} } as never;
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
  const route = createBotRoutes(registry);
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
  const route = createBotRoutes(registry);
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
  const route = createBotRoutes(registry);
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
  const route = createBotRoutes(registry);
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
  const route = createBotRoutes(registry);
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
  const route = createBotRoutes(registry);
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
  const route = createBotRoutes(registry);
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

test("reads the Bot's directory's git status, and says when there is no repository", async () => {
  const root = await mkdtemp(join(tmpdir(), "bot-git-route-"));
  try {
    const registry = {
      async snapshot() {
        return { version: 2, revision: 1, bots: [{ ...bot, environment: { kind: "directory", path: root } }] };
      },
    } as unknown as BotRegistry;
    const route = createBotRoutes(registry);
    const plain = new Request("http://localhost/api/bots/bot-1/git");
    const none = await route(plain, new URL(plain.url), server);
    expect(await none?.json()).toEqual({ botId: "bot-1", repository: false, branch: null, entries: [] });

    await Bun.spawn(["git", "init", "--initial-branch=main"], { cwd: root, stdout: "ignore" }).exited;
    await writeFile(join(root, "new.ts"), "fresh\n");
    const status = await route(plain, new URL(plain.url), server);
    expect(await status?.json()).toEqual({
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
    const unknown = new Request("http://localhost/api/bots/bot-2/git");
    expect((await route(unknown, new URL(unknown.url), server))?.status).toBe(404);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
