import { describe, expect, test } from "bun:test";
import type { CliInputReceipt, CliInputStatus } from "@agentdesk/agent-feed-wire";
import { createCliInputRoutes, type CliInputDependencies } from "@/http/session-routes/cliInputRoutes";

const SESSION = "2adc3708-fadb-4e2f-a744-322df224faf4";
const server = { timeout() {} } as never;

function routeWith(overrides: Partial<CliInputDependencies> = {}) {
  const sent: { sessionId: string; text: string }[] = [];
  const inbox: CliInputDependencies = {
    status: async (): Promise<CliInputStatus> =>
      ({ available: true, entrypoint: "cli", reason: null, tmuxSession: null }),
    deliver: async (sessionId, text): Promise<CliInputReceipt> => {
      sent.push({ sessionId, text });
      return { delivered: true, reason: null };
    },
    ...overrides,
  };
  return { route: createCliInputRoutes(inbox), sent };
}

function call(
  route: ReturnType<typeof createCliInputRoutes>,
  method: string,
  path: string,
  body?: unknown,
) {
  const url = new URL(`http://127.0.0.1${path}`);
  const request = new Request(url.toString(), {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return route(request, url, server);
}

describe("addressing", () => {
  test("a claude session id is the whole address", async () => {
    const { route } = routeWith();
    const response = await call(route, "GET", `/api/sessions/claude/${SESSION}/input`);
    expect(response?.status).toBe(200);
    expect(await response!.json()).toEqual({ available: true, entrypoint: "cli", reason: null, tmuxSession: null });
  });

  test("codex is refused by the pattern, because it has no inbox to write to", async () => {
    const { route } = routeWith();
    expect(await call(route, "GET", `/api/sessions/codex/${SESSION}/input`)).toBeUndefined();
  });

  test("a path that is not a session id is not an address", async () => {
    const { route } = routeWith();
    expect(await call(route, "GET", "/api/sessions/claude/../../etc/input")).toBeUndefined();
  });

  test("methods other than GET and POST fall through rather than acting", async () => {
    const { route } = routeWith();
    expect(await call(route, "DELETE", `/api/sessions/claude/${SESSION}/input`)).toBeUndefined();
  });
});

describe("delivering", () => {
  test("hands the turn to the inbox", async () => {
    const { route, sent } = routeWith();
    const response = await call(route, "POST", `/api/sessions/claude/${SESSION}/input`, {
      text: "ship it",
    });
    expect(response?.status).toBe(200);
    expect(await response!.json()).toEqual({ delivered: true, reason: null });
    expect(sent).toEqual([{ sessionId: SESSION, text: "ship it" }]);
  });

  test("an undeliverable turn is an answer carrying the reason, not an error status", async () => {
    // The panel renders the reason. A non-2xx would make "this session is not running" look like
    // a malformed request to every client that branches on status before reading the body.
    const { route } = routeWith({
      deliver: async () => ({ delivered: false, reason: "not-running" }),
    });
    const response = await call(route, "POST", `/api/sessions/claude/${SESSION}/input`, {
      text: "hello",
    });
    expect(response?.status).toBe(200);
    expect(await response!.json()).toEqual({ delivered: false, reason: "not-running" });
  });

  test("a blank turn never reaches the session", async () => {
    const { route, sent } = routeWith();
    const response = await call(route, "POST", `/api/sessions/claude/${SESSION}/input`, {
      text: "   ",
    });
    expect(response?.status).toBe(400);
    expect(sent).toEqual([]);
  });

  test("a missing text is a 400, not an empty message", async () => {
    const { route, sent } = routeWith();
    const response = await call(route, "POST", `/api/sessions/claude/${SESSION}/input`, {});
    expect(response?.status).toBe(400);
    expect(sent).toEqual([]);
  });

  test("an oversized turn is refused before delivery", async () => {
    const { route, sent } = routeWith();
    const response = await call(route, "POST", `/api/sessions/claude/${SESSION}/input`, {
      text: "x".repeat(128 * 1024 + 1),
    });
    expect(response?.status).toBe(413);
    expect(sent).toEqual([]);
  });

  test("a body that is not JSON is a 400", async () => {
    const { route } = routeWith();
    const url = new URL(`http://127.0.0.1/api/sessions/claude/${SESSION}/input`);
    const response = await createCliInputRoutes({
      status: async () => ({ available: false, entrypoint: null, reason: "not-running", tmuxSession: null }),
      deliver: async () => ({ delivered: false, reason: "not-running" }),
    })(new Request(url.toString(), { method: "POST", body: "{{{" }), url, server);
    expect((await response)?.status).toBe(400);
  });

  test("a GET never delivers, because the panel polls it to choose a composer", async () => {
    const { route, sent } = routeWith();
    await call(route, "GET", `/api/sessions/claude/${SESSION}/input`);
    expect(sent).toEqual([]);
  });
});
