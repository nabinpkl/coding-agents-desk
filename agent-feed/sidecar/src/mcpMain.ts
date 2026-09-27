// stdio entrypoint for the relay MCP server. Separate from server.ts by design: the HTTP sidecar
// stays long lived while each runtime spawns its own copy of this, one per Claude Code session and
// one per opencode serve.
//
// Which runtime it is comes from the parent process, not from a flag: Claude Code's child hangs off
// the session's own process, while opencode's hangs off `opencode serve`, which serves every
// session on the machine. That is the same fact the session id comes from under Claude, so one
// read answers both.
//
// stdout carries MCP frames only, so every console.log is rerouted to stderr before anything logs.
import { createRelayMcpServer } from "@/messaging/relayMcp";
import { parentRuntime } from "@/messaging/parentRuntime";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const stderrWrite = console.error.bind(console);
console.log = (...args: unknown[]) => stderrWrite(...args);

await createRelayMcpServer({ source: parentRuntime() }).connect(new StdioServerTransport());
