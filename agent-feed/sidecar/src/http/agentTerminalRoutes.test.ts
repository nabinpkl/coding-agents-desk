import { expect, spyOn, test } from "bun:test";
import type {
  AgentTerminalDescriptor,
} from "@agentdesk/agent-feed-wire";
import { AgentTerminalConflictError } from "../terminal/agentTerminalService.ts";
import {
  createAgentTerminalRoutes,
  type AgentTerminalRoutesService,
} from "./agentTerminalRoutes.ts";

const TERMINAL_ID = "2adc3708-fadb-4e2f-a744-322df224faf4";
const SESSION_ID = "48fc14ac-0c09-4d3b-85d1-9c57c990db32";
const server = { timeout() {} } as never;
const descriptor: AgentTerminalDescriptor = {
  terminalId: TERMINAL_ID,
  ptySessionName: `agent-resume-codex-${SESSION_ID}`,
  pid: 42,
  columns: 90,
  rows: 28,
};

function fakeService(overrides: Partial<AgentTerminalRoutesService> = {}) {
  const calls: unknown[] = [];
  const service: AgentTerminalRoutesService = {
    async open(context, dimensions) {
      calls.push({ open: { context, dimensions } });
      return descriptor;
    },
    has: () => true,
    subscribe(_terminalId, listener) {
      listener({ type: "output", revision: "1", data: "aGk=" });
      return () => calls.push({ unsubscribed: true });
    },
    sendInput(terminalId, data, encoding) {
      calls.push({ input: { terminalId, data, encoding } });
    },
    updateViewport(terminalId, viewport) {
      calls.push({ viewport: { terminalId, viewport } });
    },
    close(terminalId, mode) {
      calls.push({ close: { terminalId, mode } });
    },
    ...overrides,
  };
  return { calls, route: createAgentTerminalRoutes(service) };
}

async function call(
  route: ReturnType<typeof createAgentTerminalRoutes>,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response | undefined> {
  const url = new URL(`http://127.0.0.1${path}`);
  return await route(new Request(url.toString(), {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), url, server);
}

test("opens the selected provider session through the sidecar PTY service", async () => {
  const { calls, route } = fakeService();
  const response = await call(route, "POST", "/api/terminals", {
    context: { projectPath: "/projects/agent-desk", source: "codex", sessionId: SESSION_ID },
    columns: 90,
    rows: 28,
  });

  expect(response?.status).toBe(201);
  expect(await response?.json()).toEqual(descriptor);
  expect(calls).toEqual([{ open: {
    context: { projectPath: "/projects/agent-desk", source: "codex", sessionId: SESSION_ID },
    dimensions: { columns: 90, rows: 28 },
  } }]);
});

test("streams base64 PTY output as an Agent Feed SSE event", async () => {
  const { calls, route } = fakeService();
  const response = await call(route, "GET", `/api/terminals/${TERMINAL_ID}/stream`);
  expect(response?.status).toBe(200);
  const reader = response!.body!.getReader();
  const first = await reader.read();
  expect(new TextDecoder().decode(first.value)).toBe(
    'data: {"type":"output","revision":"1","data":"aGk="}\n\n',
  );
  const debug = spyOn(console, "debug").mockImplementation(() => {});
  await reader.cancel();
  debug.mockRestore();
  expect(calls).toContainEqual({ unsubscribed: true });
});

test("posts xterm input and viewport state without a native bridge", async () => {
  const { calls, route } = fakeService();
  expect((await call(route, "POST", `/api/terminals/${TERMINAL_ID}/input`, {
    data: "pwd\r",
    encoding: "utf8",
  }))?.status)
    .toBe(204);
  expect((await call(route, "POST", `/api/terminals/${TERMINAL_ID}/viewport`, {
    sequence: "3",
    active: true,
    claim: true,
    columns: 100,
    rows: 32,
  }))?.status).toBe(204);
  expect(calls).toEqual([
    { input: { terminalId: TERMINAL_ID, data: "pwd\r", encoding: "utf8" } },
    { viewport: {
      terminalId: TERMINAL_ID,
      viewport: { sequence: "3", active: true, claim: true, columns: 100, rows: 32 },
    } },
  ]);
});

test("maps an occupied provider session to a typed conflict", async () => {
  const { route } = fakeService({
    open: async () => {
      throw new AgentTerminalConflictError("the agent session is already active in another terminal");
    },
  });
  const response = await call(route, "POST", "/api/terminals", {
    context: { projectPath: "/projects/agent-desk", source: "codex", sessionId: SESSION_ID },
    columns: 80,
    rows: 24,
  });

  expect(response?.status).toBe(409);
  expect(await response?.json()).toEqual({
    error: {
      code: "terminal-conflict",
      message: "the agent session is already active in another terminal",
      retryable: false,
    },
  });
});
