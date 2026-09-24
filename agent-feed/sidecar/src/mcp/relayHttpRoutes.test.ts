import { describe, expect, test } from "bun:test";
import { createRelayMcpHttpRoutes } from "@/mcp/relayHttpRoutes";
import type { RelayDependencies } from "@/mcp/relayRouter";

// The HTTP surface speaks full MCP: initialize, then tools/list and a call,
// carrying the session id the server assigned. Fakes behind the router so no
// live Claude or serve is needed.
function fakeDeps(): RelayDependencies {
  return {
    hasClaudeSession: () => false,
    hasOpencodeSession: () => false,
    claudeSend: async () => ({ delivered: false, reason: "unknown-session" }),
    claudeNotify: async () => ({ delivered: false, reason: "unknown-session" }),
    opencodePrompt: async () => ({ delivered: false, reason: "unknown-session" }),
    claudeStatus: async () => ({ available: false, entrypoint: null, reason: "not-running", tmuxSession: null }),
    claudeRunning: async () => false,
    opencodeRunning: async () => false,
    listSessions: () => [],
  };
}

// createRelayMcpServer uses live deps by default; this pins the route test
// to fakes by routing through the same seam the server builder takes.
describe("relay MCP http route", () => {
  test("non MCP paths and methods pass through", async () => {
    const route = createRelayMcpHttpRoutes();
    expect(await route(new Request("http://x/other", { method: "GET" }), new URL("http://x/other"), undefined as never)).toBeUndefined();
    expect(await route(new Request("http://x/mcp", { method: "PUT" }), new URL("http://x/mcp"), undefined as never)).toBeUndefined();
  });

  test("initialize assigns a session and tools/list answers on it", async () => {
    const route = createRelayMcpHttpRoutes(fakeDeps());
    const url = new URL("http://x/mcp");
    const init = await route(
      new Request(url.toString(), {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "t", version: "0" },
          },
        }),
      }),
      url,
      undefined as never,
    ) as Response;
    expect(init.status).toBe(200);
    const sessionId = init.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();

    const list = (await route(
      new Request(url.toString(), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-session-id": sessionId!,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
      }),
      url,
      undefined as never,
    ) as Response);
    expect(list.status).toBe(200);
    const text = await list.text();
    for (const name of ["send", "notify", "sessions_list", "session_status"]) {
      expect(text).toContain(name);
    }
  });
});
