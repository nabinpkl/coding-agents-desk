import { expect, test } from "bun:test";
import type { AgentBackend, AgentSessionDescriptor } from "@/agents/agentBackend";
import { createAgentRoutes } from "@/http/agent-routes/agentRoutes";

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

test("message routes carry image attachments to an opencode backend and refuse them elsewhere", async () => {
  const received: { attachments: unknown }[] = [];
  const base = fakeBackend();
  const route = createAgentRoutes((id) => {
    if (id !== "opencode" && id !== "pi") return undefined;
    return {
      ...base,
      id,
      send: async (sessionId: string, requestId: string, _text: string, delivery: "next" | "steer", attachments?: readonly unknown[]) => {
        received.push({ attachments });
        return { requestId, delivery: "followUp" as const };
      },
    };
  });
  const image = {
    method: "POST",
    body: JSON.stringify({
      requestId: "r-img",
      text: "look at this",
      delivery: "next",
      files: [{ data: Buffer.from("png-bytes").toString("base64"), mime: "image/png", name: "shot.png" }],
    }),
  };
  const accepted = new Request("http://localhost/api/agent-sessions/opencode/s1/messages", image);
  expect((await route(accepted, new URL(accepted.url), server))?.status).toBe(202);
  expect(received).toHaveLength(1);
  expect(received[0]!.attachments).toEqual([
    { data: Buffer.from("png-bytes").toString("base64"), mime: "image/png", name: "shot.png" },
  ]);

  const refused = new Request("http://localhost/api/agent-sessions/pi/s1/messages", image);
  const refusal = await route(refused, new URL(refused.url), server);
  expect(refusal?.status).toBe(400);
  expect(await refusal?.json()).toMatchObject({ error: { code: "unsupported-attachments" } });

  const badData = new Request("http://localhost/api/agent-sessions/opencode/s1/messages", {
    method: "POST",
    body: JSON.stringify({
      requestId: "r-bad",
      text: "look",
      delivery: "next",
      files: [{ data: "!!!", mime: "image/png", name: "shot.png" }],
    }),
  });
  const rejected = await route(badData, new URL(badData.url), server);
  expect(rejected?.status).toBe(400);
  expect(await rejected?.json()).toMatchObject({ error: { code: "invalid-attachments" } });
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
    body: JSON.stringify({ requestId: "r2", text: "x".repeat(256 * 1024 + 1), delivery: "next" }),
  });
  expect((await route(huge, new URL(huge.url), server))?.status).toBe(413);
});

test("Pi pages reject raw mode instead of silently renumbering", async () => {
  const backend = fakeBackend();
  const route = createAgentRoutes(() => backend);
  const request = new Request("http://localhost/api/sessions/pi/s1/events?mode=raw");
  expect((await route(request, new URL(request.url), server))?.status).toBe(400);
});

test("a live page carries the runtime projection identity", async () => {
  const base = fakeBackend();
  const backend: AgentBackend = {
    ...base,
    id: "opencode",
    page: async () => ({
      events: [],
      total: 0,
      mode: "nice" as const,
      sequence: 0,
      runState: "idle" as const,
      queue: { steer: 0, followUp: 0 },
      projectionId: "projection-live",
    }),
  };
  const route = createAgentRoutes((id) => id === "opencode" ? backend : undefined);
  const request = new Request("http://localhost/api/agent-sessions/opencode/s1/events?mode=nice");
  const response = await route(request, new URL(request.url), server);
  expect(await response?.json()).toMatchObject({ projectionId: "projection-live" });
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
