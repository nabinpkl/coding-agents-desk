// MCP endpoint for opencode tool-out: the same four hub tools the local relay child serves,
// spoken directly by the hub so a code change deploys once instead of stranding per-serve children.
//
// Auth runs per HTTP request like every other route: the JWT in cf-access-jwt-assertion names the
// principal, and the principal travels to the tool handlers in an AsyncLocalStorage cell, because one
// McpServer serves every principal while each request authenticates separately. The hub's own
// sender() check stays the guard; this layer translates, it does not re-decide.
//
// Claude keeps the local child (only a local `server:` opt-in can push into a session), so this
// endpoint builds `as` as an opencode session address. Inbound delivery still rides the sidecar's
// per-session streams and prompt queue, untouched by any of this.

import { AsyncLocalStorage } from "node:async_hooks";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { DirectoryEntry, Message } from "@agentdesk/agent-feed-wire";
import { z } from "zod";
import { Unauthorized, type Identified } from "@/auth";
import type { Messages } from "@/messages";
import type { RateLimiter } from "@/ratelimit";
import type { RouteDeps } from "@/routes";

export const MCP_PATH = "/mcp";

interface CallContext {
  identified: Identified;
}

const calls = new AsyncLocalStorage<CallContext>();

function context(): CallContext {
  const current = calls.getStore();
  if (!current) throw new Error("tool called outside an authenticated request");
  return current;
}

function text(value: unknown) {
  return { content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value) }] };
}

function failure(error: unknown) {
  return { ...text(error instanceof Error ? error.message : String(error)), isError: true as const };
}

/** The fields an agent needs, matching what the relay child returns for the same calls. */
function compactMessage(message: Message) {
  return {
    id: message.id,
    threadId: message.threadId,
    from: message.from,
    to: message.to,
    kind: message.kind,
    state: message.state,
    body: message.body,
    refs: message.refs,
    createdAt: message.createdAt,
  };
}

function compactEntry(entry: DirectoryEntry) {
  return { address: entry.address, name: entry.name, machine: entry.machine, reachability: entry.reachability, cwd: entry.cwd };
}

export function buildMcpServer(deps: Pick<RouteDeps, "messages" | "limiter">): McpServer {
  const server = new McpServer(
    { name: "agent-hub", version: "0.1.0" },
    { capabilities: { tools: { listChanged: true } } },
  );

  server.registerTool(
    "hub_send",
    {
      description: "Start a conversation on the agent messaging hub: a request (expects a reply) or a notice (FYI) to the owner (\"human\") or a Bot (\"bot:<id>\", or \"bot:<id>/<sessionId>\" when the Bot curates several sessions). session_id names the opencode session sending, as shown in hub_directory.",
      inputSchema: {
        to: z.string(),
        body: z.string(),
        kind: z.enum(["request", "notice"]).default("request"),
        session_id: z.string(),
      },
    },
    async ({ to, body, kind, session_id }: { to: string; body: string; kind: "request" | "notice"; session_id: string }) => {
      try {
        const { identified } = context();
        deps.limiter?.take(identified.clientId, "writes", "mcp hub_send");
        const sent = deps.messages.send(identified.principal, { as: `opencode:${session_id}`, to, kind, body });
        return text(compactMessage(sent));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "hub_reply",
    {
      description: "Answer a message delivered to this opencode session, in its thread, to its sender. Needs no session id: the hub knows which session the message reached.",
      inputSchema: {
        message_id: z.string(),
        body: z.string(),
      },
    },
    async ({ message_id, body }: { message_id: string; body: string }) => {
      try {
        const { identified } = context();
        deps.limiter?.take(identified.clientId, "writes", "mcp hub_reply");
        const message = deps.messages.get(message_id);
        const deliveredTo = message.deliveredTo;
        if (!deliveredTo || !deliveredTo.startsWith("opencode:")) {
          throw new Error(`message ${message_id} was not delivered to an opencode session`);
        }
        const sent = deps.messages.send(identified.principal, { as: deliveredTo, inReplyTo: message_id, body });
        return text(compactMessage(sent));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "hub_inbox",
    {
      description: "Messages to this machine's opencode sessions that are not answered yet. Used for recovery after a compaction.",
      inputSchema: {},
    },
    async () => {
      try {
        const { identified } = context();
        deps.limiter?.take(identified.clientId, "reads", "mcp hub_inbox");
        const entries = deps.messages.directory.list(Date.now());
        const mine = entries.filter((e) => e.session?.startsWith("opencode:") && e.machine === identified.principal.machine);
        const all = mine.flatMap((e) => deps.messages.inbox(e.session!));
        return text(all.map(compactMessage));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "hub_directory",
    {
      description: "Who can be messaged: the owner, the Bots, and every session, with whether each is reachable now. A message to an unreachable address waits for it.",
      inputSchema: {},
    },
    async () => {
      try {
        const { identified } = context();
        deps.limiter?.take(identified.clientId, "reads", "mcp hub_directory");
        return text(deps.messages.directory.list(Date.now()).map(compactEntry));
      } catch (error) {
        return failure(error);
      }
    },
  );

  return server;
}

/**
 * One MCP session per transport, following the SDK's stateful pattern: a POST without a session id
 * opens one, later requests ride it by the mcp-session-id header, and DELETE closes it. Every
 * request authenticates separately, so a rotated or revoked token stops at the next call rather than
 * at the next session.
 */
export function createMcpFetch(deps: RouteDeps): (request: Request) => Promise<Response> {
  const transports = new Map<string, WebStandardStreamableHTTPServerTransport>();
  return async (request) => {
    const start = performance.now();
    let identified: Identified;
    try {
      identified = await deps.verify(request.headers.get("cf-access-jwt-assertion"));
    } catch (error) {
      return Response.json({ error: error instanceof Unauthorized ? error.message : "internal error" }, { status: error instanceof Unauthorized ? 401 : 500 });
    }
    const sessionId = request.headers.get("mcp-session-id") ?? undefined;
    try {
      let transport = sessionId ? transports.get(sessionId) : undefined;
      if (request.method === "POST" && !transport) {
        transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
          onsessioninitialized: (id) => {
            transports.set(id, transport!);
          },
          onsessionclosed: (id) => {
            transports.delete(id);
          },
        });
        await buildMcpServer(deps).connect(transport);
      }
      if (!transport) {
        return Response.json({ error: "no mcp session; POST without a session id to open one" }, { status: 400 });
      }
      const response = await calls.run({ identified }, () => transport!.handleRequest(request));
      deps.log({ method: request.method, path: MCP_PATH, status: response.status, ms: Math.round(performance.now() - start) });
      return response;
    } catch (error) {
      deps.log({ level: "error", path: MCP_PATH, error: error instanceof Error ? (error.stack ?? error.message) : String(error) });
      return Response.json({ error: "internal error" }, { status: 500 });
    }
  };
}
