// The relay as a Streamable HTTP endpoint on the sidecar itself: POST/GET/
// DELETE `/mcp`. Same four tools as the stdio server, same live catalog,
// portable across machines with no file path: `http://<host>:<port>/mcp`.
//
// Stateful mode: one transport per MCP session id, kept in a map and
// closed on DELETE. No new auth: the sidecar binds loopback and the
// tailnet is the trust boundary, same posture as every other route.

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { RouteHandler } from "@/http/route";
import { createRelayMcpServer } from "@/mcp/relayMcp";
import type { RelayDependencies } from "@/mcp/relayRouter";

const MCP_ROUTE = /^\/mcp\/?$/;

export function createRelayMcpHttpRoutes(deps?: RelayDependencies): RouteHandler {
  const transports = new Map<string, WebStandardStreamableHTTPServerTransport>();

  return (request, url) => {
    if (!MCP_ROUTE.test(url.pathname)) return undefined;
    if (request.method !== "POST" && request.method !== "GET" && request.method !== "DELETE") {
      return undefined;
    }
    return handle(request);
  };

  async function handle(request: Request): Promise<Response> {
    const sessionId = request.headers.get("mcp-session-id") ?? undefined;
    const held = sessionId !== undefined ? transports.get(sessionId) : undefined;
    if (held !== undefined) return held.handleRequest(request);

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (id) => {
        transports.set(id, transport);
      },
      onsessionclosed: (id) => {
        transports.delete(id);
      },
    });
    const server = createRelayMcpServer(deps);
    await server.connect(transport);
    return transport.handleRequest(request);
  };
}
