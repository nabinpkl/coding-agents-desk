/* Process entry: config, store, service, auth, HTTP. Exits non-zero on bad
 * config. Closes the listener, the MCP handler and the database on SIGTERM. */
import { serve } from "@hono/node-server";
import { createAccessVerifier } from "./auth/access-jwt.ts";
import { loadConfig } from "./config.ts";
import { createApp } from "./http/app.ts";
import { createHubClient } from "./hub.ts";
import { createMcpEndpoint } from "./mcp/mcp-endpoint.ts";
import { SERVER_NAME, SERVER_VERSION } from "./mcp/tools.ts";
import { createAnnotationService } from "./service/annotations.ts";
import { openSqliteStore } from "./store/sqlite-store.ts";

function log(line: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ t: new Date().toISOString(), ...line })}\n`);
}

const config = loadConfig(process.env);
const store = openSqliteStore(config.dbFile);
const service = createAnnotationService(store, createHubClient(config.hub));
const mcp = createMcpEndpoint(service, (e) => log({ level: "error", source: "mcp", error: e.stack ?? String(e) }));
const app = createApp({
  service,
  verify: createAccessVerifier({ ...config.access }),
  mcp,
  mcpAllowedOrigins: config.mcpAllowedOrigins,
  log,
});

const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  log({ msg: `${SERVER_NAME} ${SERVER_VERSION} listening`, host: config.host, port: info.port, db: config.dbFile });
});

let stopping = false;
function shutdown(signal: string): void {
  if (stopping) return;
  stopping = true;
  log({ msg: "shutting down", signal });
  server.close(() => {
    void mcp.close().finally(() => {
      store.close();
      process.exit(0);
    });
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
