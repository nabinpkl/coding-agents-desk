// stdio entrypoint for the ask_owner MCP server, which the `ask-owner` mod starts for each Claude
// session (`mods/ask-owner/.mcp.json`). One process per session: its parent is the session, which
// is how it knows whose question it is carrying (`readRelaySession`).
//
// stdout carries MCP frames only, so every console.log is rerouted to stderr before anything logs.
// It exits when its input closes, which is the session going away, so a call still waiting at the
// sidecar is let go with it rather than held open by an orphan.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { WaitAskOwnerCommand } from "@agentdesk/agent-feed-wire";
import { createAskOwnerMcpServer } from "@/asks/askOwnerMcp";
import { localOrigin } from "@/config/configHosts";
import { readRelaySession } from "@/messaging/relaySession";

const stderrWrite = console.error.bind(console);
console.log = (...args: unknown[]) => stderrWrite(...args);

process.stdin.on("close", () => process.exit(0));

const server = createAskOwnerMcpServer({
  session: () => {
    const session = readRelaySession();
    return typeof session === "string" ? session : { source: "claude", sessionId: session.sessionId };
  },
  post: (command: WaitAskOwnerCommand, signal: AbortSignal) =>
    fetch(`${localOrigin}/api/asks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(command),
      signal,
    }),
  pause: (ms, signal) =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    }),
  log: (line) => stderrWrite(line),
});

await server.connect(new StdioServerTransport());
