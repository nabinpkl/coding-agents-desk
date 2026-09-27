// Boot: config, store, verifier, HTTP. Streams do not survive a restart, so every session starts
// disconnected and every unconfirmed push goes back to the queue.

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createVerifier } from "@/auth";
import { loadConfig } from "@/config";
import { Messages } from "@/messages";
import { createFetch } from "@/routes";
import { HubStore } from "@/store";

const config = loadConfig(process.env);
mkdirSync(dirname(config.dbFile), { recursive: true });
const store = new HubStore(config.dbFile);
store.disconnectAll();
const messages = new Messages(store);
const log = (line: Record<string, unknown>) => console.log(JSON.stringify({ at: new Date().toISOString(), ...line }));

const server = Bun.serve({
  hostname: config.host,
  port: config.port,
  // Streams hold connections open; the heartbeat keeps them under this.
  idleTimeout: 60,
  fetch: createFetch({ messages, verify: createVerifier(config), log }),
});

const sweep = setInterval(() => {
  const expired = messages.expire();
  if (expired > 0) log({ event: "expired", count: expired });
}, 60_000);

log({ event: "listening", host: config.host, port: server.port, principals: [...config.principals.values()].map((p) => p.label) });

function shutdown(): void {
  clearInterval(sweep);
  void server.stop(true);
  store.close();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
