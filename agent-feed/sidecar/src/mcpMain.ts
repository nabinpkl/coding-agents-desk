// stdio entrypoint for the relay MCP server. Separate from server.ts by
// design: the HTTP sidecar stays long lived while MCP hosts spawn this per
// connection over stdio.
//
// Two stdio rules: stdout carries MCP frames only, so every console.log is
// rerouted to stderr before anything that logs; and the shared catalog is
// started so session resolution sees the same sessions the HTTP sidecar
// would (Claude registry plus opencode serve reconcile).
import { startCatalog } from "@/transcripts/catalog/transcriptCatalog";
import { runRelayMcpStdio } from "@/mcp/relayMcp";

const stderrWrite = console.error.bind(console);
console.log = (...args: unknown[]) => stderrWrite(...args);

await startCatalog();
await runRelayMcpStdio();
