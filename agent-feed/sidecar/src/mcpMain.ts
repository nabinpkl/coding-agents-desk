// stdio entrypoint for the relay MCP server. Separate from server.ts by design: the HTTP sidecar
// stays long lived while each Claude Code session spawns its own copy of this.
//
// Claude Code starts one stdio child per MCP server per session, so the child reads its session
// from the parent process. OpenCode sessions never spawn this: they reach the hub through its MCP
// endpoint as a remote server.
//
// stdout carries MCP frames only, so every console.log is rerouted to stderr before anything logs.
import { createRelayMcpServer } from "@/messaging/relayMcp";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const stderrWrite = console.error.bind(console);
console.log = (...args: unknown[]) => stderrWrite(...args);

await createRelayMcpServer().connect(new StdioServerTransport());
