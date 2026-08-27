import { expect, test } from "bun:test";
import type { BotView } from "@agentdesk/agent-feed-wire";
import { BotConflictError, type BotRegistry } from "../bots/botRegistry.ts";
import { createBotRoutes } from "./botRoutes.ts";

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

test("attaches selected sessions through the Bot-scoped route", async () => {
  const calls: unknown[] = [];
  const registry = {
    async attachSessions(botId: string, command: unknown, actor: unknown) {
      calls.push({ botId, command, actor });
      return bot;
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
  expect(await response?.json()).toEqual(bot);
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
