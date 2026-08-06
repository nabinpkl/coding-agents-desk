import { expect, test } from "bun:test";
import type { AgentBackend } from "../agents/agentBackend.ts";
import { createAgentRoutes } from "./agentRoutes.ts";

function fakeBackend(): AgentBackend {
  return {
    id: "pi",
    capabilities: { modes: ["nice"], canSend: true, canSteer: true, canAbort: true, canFetchRaw: false, canOpenTerminal: false, supportsExtensionUi: true, canStreamLive: false },
    describeSession() { return undefined; },
    async createSession() { throw new Error("not used"); },
    async page() { return { events: [], total: 0, mode: "nice", sequence: 0, runState: "idle", queue: { steer: 0, followUp: 0 } }; },
    async subscribe() { return () => {}; },
    async send(sessionId, requestId, _text, delivery) { return { requestId, delivery: delivery === "steer" ? "steer" : "immediate" }; },
    async abort(_sessionId, requestId) { return { requestId, delivery: "abort" }; },
    async subscribeUi() { return () => {}; },
    async respondToUi() { return "accepted"; },
    async dispose() {},
  };
}

const server = { timeout() {} } as never;

test("message routes validate and return a correlated accepted receipt", async () => {
  const backend = fakeBackend();
  const route = createAgentRoutes((id) => id === "pi" ? backend : undefined);
  const request = new Request("http://localhost/api/agent-sessions/pi/s1/messages", {
    method: "POST",
    body: JSON.stringify({ requestId: "r1", text: "hello", delivery: "next" }),
  });
  const response = await route(request, new URL(request.url), server);
  expect(response?.status).toBe(202);
  expect(await response?.json()).toEqual({ requestId: "r1", delivery: "immediate" });
});

test("message routes reject empty and oversized prompts", async () => {
  const backend = fakeBackend();
  const route = createAgentRoutes(() => backend);
  const empty = new Request("http://localhost/api/agent-sessions/pi/s1/messages", {
    method: "POST",
    body: JSON.stringify({ requestId: "r1", text: "  ", delivery: "next" }),
  });
  expect((await route(empty, new URL(empty.url), server))?.status).toBe(400);
  const huge = new Request("http://localhost/api/agent-sessions/pi/s1/messages", {
    method: "POST",
    body: JSON.stringify({ requestId: "r2", text: "x".repeat(256 * 1024), delivery: "next" }),
  });
  expect((await route(huge, new URL(huge.url), server))?.status).toBe(413);
});

test("Pi pages reject raw mode instead of silently renumbering", async () => {
  const backend = fakeBackend();
  const route = createAgentRoutes(() => backend);
  const request = new Request("http://localhost/api/sessions/pi/s1/events?mode=raw");
  expect((await route(request, new URL(request.url), server))?.status).toBe(400);
});

test("extension UI responses are correlated through the backend broker", async () => {
  const backend = fakeBackend();
  const route = createAgentRoutes(() => backend);
  const request = new Request("http://localhost/api/agent-sessions/pi/s1/ui/ui-1", {
    method: "POST",
    body: JSON.stringify({ value: true }),
  });
  const response = await route(request, new URL(request.url), server);
  expect(response?.status).toBe(202);
  expect(await response?.json()).toEqual({ requestId: "ui-1", delivery: "ui" });
});

test("extension UI rejects an invalid value without consuming the prompt", async () => {
  const backend = fakeBackend();
  backend.respondToUi = async () => "invalid";
  const route = createAgentRoutes(() => backend);
  const request = new Request("http://localhost/api/agent-sessions/pi/s1/ui/ui-1", {
    method: "POST",
    body: JSON.stringify({ value: "not-an-option" }),
  });
  const response = await route(request, new URL(request.url), server);
  expect(response?.status).toBe(422);
  expect(await response?.json()).toMatchObject({
    error: { code: "invalid-ui-response", requestId: "ui-1", retryable: false },
  });
});

test("extension UI acknowledges a valid answer that lost the viewer race", async () => {
  const backend = fakeBackend();
  backend.respondToUi = async () => "already-resolved";
  const route = createAgentRoutes(() => backend);
  const request = new Request("http://localhost/api/agent-sessions/pi/s1/ui/ui-1", {
    method: "POST",
    body: JSON.stringify({ value: true }),
  });
  const response = await route(request, new URL(request.url), server);
  expect(response?.status).toBe(202);
  expect(await response?.json()).toEqual({ requestId: "ui-1", delivery: "ui-already-resolved" });
});
