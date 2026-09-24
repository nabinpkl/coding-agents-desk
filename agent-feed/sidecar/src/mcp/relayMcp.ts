// MCP server wiring over the relay router: stdio transport, four generic
// tools, live sidecar functions behind the dependency seam. Pi and Codex
// are never consulted.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  cliInputStatus,
  deliverCliInput,
} from "@/input/claudeSessionInbox";
import {
  submitTmuxComposer,
  syncTmuxComposer,
} from "@/input/tmuxComposer";
import { serveGet, serveRequest } from "@/agents/opencodeClient";
import {
  findSession,
  getSnapshot,
} from "@/transcripts/catalog/catalogState";
import {
  relayList,
  relayNotify,
  relaySend,
  relayStatus,
  type ListedSession,
  type RelayDependencies,
  type SendResult,
} from "@/mcp/relayRouter";

const sessionIdSchema = z.string().describe("Target session id (uuid).");
const textSchema = z.string().describe("Message text.");

async function claudeSend(sessionId: string, text: string): Promise<SendResult> {
  const synced = await syncTmuxComposer(sessionId, text);
  if (synced.reason !== null || synced.text === null) {
    return { delivered: false, reason: synced.reason ?? "sync-failed" };
  }
  const submitted = await submitTmuxComposer(sessionId);
  if (submitted.reason !== null) return { delivered: false, reason: submitted.reason };
  return { delivered: true, reason: null };
}

async function claudeNotify(sessionId: string, text: string): Promise<SendResult> {
  const receipt = await deliverCliInput(sessionId, text);
  return { delivered: receipt.delivered, reason: receipt.reason };
}

async function opencodePrompt(sessionId: string, text: string): Promise<SendResult> {
  let answered: { status: number; text: string };
  try {
    answered = await serveRequest(`/api/session/${sessionId}/prompt`, { text, delivery: "queue" });
  } catch (error) {
    return { delivered: false, reason: error instanceof Error ? error.message : "serve-error" };
  }
  if (answered.status < 200 || answered.status >= 300) {
    return { delivered: false, reason: `serve-${answered.status}` };
  }
  return { delivered: true, reason: null };
}

/** Exact busyness from the serve: only sessions running a turn right now. */
async function opencodeRunning(sessionId: string): Promise<boolean> {
  let answered: { status: number; text: string };
  try {
    answered = await serveGet("/api/session/active");
  } catch {
    return false;
  }
  if (answered.status < 200 || answered.status >= 300) return false;
  try {
    const data = (JSON.parse(answered.text) as { data?: unknown }).data;
    return typeof data === "object" && data !== null && sessionId in data;
  } catch {
    return false;
  }
}

export function liveDependencies(): RelayDependencies {
  return {
    hasClaudeSession: (id) => findSession("claude", id) !== undefined,
    hasOpencodeSession: (id) => findSession("opencode", id) !== undefined,
    claudeSend,
    claudeNotify,
    opencodePrompt,
    claudeStatus: (id) => cliInputStatus(id),
    claudeRunning: async (id) => findSession("claude", id)?.lastTurnClosed === false,
    opencodeRunning,
    listSessions: (): ListedSession[] =>
      getSnapshot()
        .filter((s) => s.source === "claude" || s.source === "opencode")
        .map((s) => ({
          source: s.source as "claude" | "opencode",
          sessionId: s.sessionId,
          project: s.project,
          lastEventAt: s.lastEventAt,
          ...(s.title !== undefined ? { title: s.title } : {}),
        })),
  };
}

function resultText(result: unknown): string {
  return JSON.stringify(result);
}

export function createRelayMcpServer(deps: RelayDependencies = liveDependencies()): McpServer {
  const server = new McpServer({ name: "agent-relay", version: "0.1.0" });

  server.registerTool(
    "send",
    {
      description:
        "Send a message as the session's own user turn. Claude sessions go through the tmux composer (trusted), opencode sessions through the serve prompt endpoint. Use for action requests.",
      inputSchema: { sessionId: sessionIdSchema, text: textSchema },
    },
    async ({ sessionId, text }) => ({
      content: [{ type: "text", text: resultText(await relaySend(deps, sessionId, text)) }],
    }),
  );

  server.registerTool(
    "notify",
    {
      description:
        "Deliver an FYI note without the user-turn trust. Claude sessions go through the gated socket inbox, opencode sessions through the serve prompt path marked [fyi]. Use for background notices only.",
      inputSchema: { sessionId: sessionIdSchema, text: textSchema },
    },
    async ({ sessionId, text }) => ({
      content: [{ type: "text", text: resultText(await relayNotify(deps, sessionId, text)) }],
    }),
  );

  server.registerTool(
    "sessions_list",
    {
      description: "List live Claude and opencode sessions visible to the relay.",
      inputSchema: {},
    },
    async () => ({
      content: [{ type: "text", text: resultText(relayList(deps)) }],
    }),
  );

  server.registerTool(
    "session_status",
    {
      description: "Check whether a session is reachable and which transport send would use.",
      inputSchema: { sessionId: sessionIdSchema },
    },
    async ({ sessionId }) => ({
      content: [{ type: "text", text: resultText(await relayStatus(deps, sessionId)) }],
    }),
  );

  return server;
}

export async function runRelayMcpStdio(deps?: RelayDependencies): Promise<void> {
  const server = createRelayMcpServer(deps);
  await server.connect(new StdioServerTransport());
}
