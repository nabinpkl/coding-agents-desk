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
    observe(listener) {
      listener({
        terminalId: TERMINAL_ID,
        message: { type: "output", revision: "1", data: "aGk=" },
      });
      return () => calls.push({ unobserved: true });
    },
    requestCheckpoint(terminalId) {
      calls.push({ checkpoint: { terminalId } });
    },
    async history(terminalId, lines) {
      calls.push({ history: { terminalId, lines } });
      return "old \u001b[31mlines\u001b[0m\n";
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
    context: {
      kind: "agent-session",
      projectPath: "/projects/agent-desk",
      source: "codex",
      sessionId: SESSION_ID,
    },
    columns: 90,
    rows: 28,
  });

  expect(response?.status).toBe(201);
  expect(await response?.json()).toEqual(descriptor);
  expect(calls).toEqual([{ open: {
    context: {
      kind: "agent-session",
      projectPath: "/projects/agent-desk",
      source: "codex",
      sessionId: SESSION_ID,
    },
    dimensions: { columns: 90, rows: 28 },
  } }]);
});

test("carries every terminal's output on one stream, addressed by id", async () => {
  const { calls, route } = fakeService();
  const response = await call(route, "GET", "/api/terminals/stream");
  expect(response?.status).toBe(200);
  const reader = response!.body!.getReader();
  const first = await reader.read();
  expect(new TextDecoder().decode(first.value)).toBe(
    `data: {"terminalId":"${TERMINAL_ID}","message":{"type":"output","revision":"1","data":"aGk="}}\n\n`,
  );
  const debug = spyOn(console, "debug").mockImplementation(() => {});
  await reader.cancel();
  debug.mockRestore();
  expect(calls).toContainEqual({ unobserved: true });
});

test("a per-terminal stream is gone: the id path serves commands only", async () => {
  const { route } = fakeService();
  expect(await call(route, "GET", `/api/terminals/${TERMINAL_ID}/stream`)).toBeUndefined();
});

test("asks the PTY to replay a screen for a viewer that just arrived", async () => {
  const { calls, route } = fakeService();
  expect((await call(route, "POST", `/api/terminals/${TERMINAL_ID}/checkpoint`))?.status).toBe(204);
  expect(calls).toEqual([{ checkpoint: { terminalId: TERMINAL_ID } }]);
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

test("opens a tmux target with only the session it names", async () => {
  const { calls, route } = fakeService();
  const response = await call(route, "POST", "/api/terminals", {
    context: { kind: "tmux", session: "canvas-fork" },
    columns: 120,
    rows: 40,
  });

  expect(response?.status).toBe(201);
  expect(calls).toEqual([{ open: {
    context: { kind: "tmux", session: "canvas-fork" },
    dimensions: { columns: 120, rows: 40 },
  } }]);
});

test("a context without a known kind is refused before the service sees it", async () => {
  const { calls, route } = fakeService();
  const response = await call(route, "POST", "/api/terminals", {
    context: { projectPath: "/projects/agent-desk", source: "codex", sessionId: SESSION_ID },
    columns: 80,
    rows: 24,
  });

  expect(response?.status).toBe(400);
  expect(calls).toEqual([]);
});

test("hands back the scrollback a viewer was never sent, escapes intact", async () => {
  const { calls, route } = fakeService();
  const response = await call(route, "GET", `/api/terminals/${TERMINAL_ID}/history?lines=2000`);

  expect(response?.status).toBe(200);
  expect(await response?.json()).toEqual({
    data: Buffer.from("old \u001b[31mlines\u001b[0m\n", "utf8").toString("base64"),
  });
  expect(calls).toEqual([{ history: { terminalId: TERMINAL_ID, lines: 2000 } }]);
});

test("refuses a history request for an unusable number of lines", async () => {
  const { calls, route } = fakeService();
  for (const lines of ["0", "-1", "1.5", "50001", "all"]) {
    const response = await call(route, "GET", `/api/terminals/${TERMINAL_ID}/history?lines=${lines}`);
    expect(response?.status).toBe(400);
  }
  expect(calls).toEqual([]);
});

test("maps an occupied provider session to a typed conflict", async () => {
  const { route } = fakeService({
    open: async () => {
      throw new AgentTerminalConflictError("the agent session is already active in another terminal");
    },
  });
  const response = await call(route, "POST", "/api/terminals", {
    context: {
      kind: "agent-session",
      projectPath: "/projects/agent-desk",
      source: "codex",
      sessionId: SESSION_ID,
    },
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
