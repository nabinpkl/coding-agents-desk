import { describe, expect, test } from "bun:test";
import type { CliSessionStatus } from "@agentdesk/agent-feed-wire";
import { createCliSessionRoutes } from "@/http/session-routes/cliSessionRoutes";

const SESSION = "2adc3708-fadb-4e2f-a744-322df224faf4";
const server = { timeout() {} } as never;

function call(path: string, method = "GET", asked: string[] = []) {
  const route = createCliSessionRoutes(async (sessionId): Promise<CliSessionStatus> => {
    asked.push(sessionId);
    return { entrypoint: "cli", tmuxSession: "alder" };
  });
  const url = new URL(`http://127.0.0.1${path}`);
  return route(new Request(url.toString(), { method }), url, server);
}

describe("cli session status route", () => {
  test("answers a claude session's status, the id lower-cased", async () => {
    const asked: string[] = [];
    const response = await call(`/api/sessions/claude/${SESSION.toUpperCase()}/cli`, "GET", asked);
    expect(response?.status).toBe(200);
    expect(await response!.json()).toEqual({ entrypoint: "cli", tmuxSession: "alder" });
    expect(asked).toEqual([SESSION]);
  });

  test("another source, a path that is not a session id, or any other method falls through", async () => {
    expect(await call(`/api/sessions/codex/${SESSION}/cli`)).toBeUndefined();
    expect(await call("/api/sessions/claude/not-a-session/cli")).toBeUndefined();
    expect(await call(`/api/sessions/claude/${SESSION}/cli`, "POST")).toBeUndefined();
  });

  test("the old turn-delivery route is gone", async () => {
    expect(await call(`/api/sessions/claude/${SESSION}/input`, "POST")).toBeUndefined();
  });
});
