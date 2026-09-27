// stdio entrypoint for the relay MCP server, which each Claude Code session starts for itself.
// Separate from server.ts by design: the HTTP sidecar stays long lived while every session spawns
// its own copy of this.
//
// stdout carries MCP frames only, so every console.log is rerouted to stderr before anything logs.
import { runRelayMcpStdio } from "@/messaging/relayMcp";

const stderrWrite = console.error.bind(console);
console.log = (...args: unknown[]) => stderrWrite(...args);

await runRelayMcpStdio();
