// `POST /api/sessions/:source/:sessionId/log`: what reaches the registry, and the codes a refusal
// answers with, which `tools/agent-log-register.sh` prints back to the agent.
import { expect, test } from "bun:test";
import type { BotSessionRef } from "@agentdesk/agent-feed-wire";
import { BotConflictError, BotNotFoundError } from "@/bots/botRegistry";
import { createAgentLogRoutes } from "@/http/agent-routes/agentLogRoutes";

const server = { upgrade: () => false } as unknown as Parameters<ReturnType<typeof createAgentLogRoutes>>[2];
const LOG = ".agents/agents-log/lint-manager.log";

function post(path: string, body: string): Request {
  return new Request(`http://127.0.0.1${path}`, {
    method: "POST",
    body,
    headers: { "content-type": "application/json" },
  });
}

function routeWith(answer: (ref: BotSessionRef, path: string) => Promise<unknown>) {
  const calls: { ref: BotSessionRef; path: string }[] = [];
  const route = createAgentLogRoutes({
    registerSessionLog: async (ref, path) => {
      calls.push({ ref, path });
      return answer(ref, path) as never;
    },
  });
  return { calls, send: async (request: Request) => route(request, new URL(request.url), server) };
}

test("a valid registration reaches the registry and answers what it did", async () => {
  const { calls, send } = routeWith(async (_ref, path) => ({ botId: "bot-1", path, status: "registered" }));
  const response = await send(post("/api/sessions/claude/38966b99-aaaa/log", JSON.stringify({ path: LOG })));
  expect(response?.status).toBe(200);
  expect(await response?.json()).toEqual({ botId: "bot-1", path: LOG, status: "registered" });
  expect(calls).toEqual([{ ref: { source: "claude", sessionId: "38966b99-aaaa" }, path: LOG }]);
});

test("the route answers only its own path and method", async () => {
  const { send } = routeWith(async () => ({}));
  expect(await send(new Request("http://127.0.0.1/api/sessions/claude/x/log"))).toBeUndefined();
  expect(await send(post("/api/sessions/claude/x/bracket", "{}"))).toBeUndefined();
});

test("refusals answer the Bot codes, and nothing malformed reaches the registry", async () => {
  const { calls, send } = routeWith(async () => {
    throw new BotNotFoundError("session claude:x is not attached to any Bot");
  });
  const cases: [Request, number, string][] = [
    [post("/api/sessions/claude/x/log", "not json"), 400, "invalid-request"],
    [post("/api/sessions/claude/x/log", "[]"), 400, "invalid-request"],
    [post("/api/sessions/claude/x/log", JSON.stringify({ path: "../escape.log" })), 400, "invalid-bot"],
    [post("/api/sessions/nobody/x/log", JSON.stringify({ path: LOG })), 400, "invalid-bot"],
    [post("/api/sessions/claude/x/log", JSON.stringify({ path: LOG })), 404, "bot-resource-not-found"],
  ];
  for (const [request, status, code] of cases) {
    const response = await send(request);
    expect(response?.status).toBe(status);
    expect(await response?.json()).toMatchObject({ error: { code } });
  }
  expect(calls).toHaveLength(1);

  const conflicted = routeWith(async () => {
    throw new BotConflictError('session claude:x is held by "A" and "B"');
  });
  const response = await conflicted.send(post("/api/sessions/claude/x/log", JSON.stringify({ path: LOG })));
  expect(response?.status).toBe(409);
});
