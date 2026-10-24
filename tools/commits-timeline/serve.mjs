#!/usr/bin/env node
// Serves the timeline page and its generated data on loopback. Tailscale puts it on the tailnet:
//
//   tailscale serve --bg --https=<port> http://127.0.0.1:<port>
//
// `just commits-timeline-tailnet` runs that with the port from config.mjs, and this file prints the
// resulting origin at startup.
import { createServer } from "node:http";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { DATA_FILE, HOST, PID_FILE, PORT, PUBLIC_DIR, tailnetOrigin } from "./config.mjs";

// Four paths and nothing else: no directory walking, so no traversal to defend against and no
// dotfiles to leak. The page requests exactly these.
const ROUTES = new Map([
  ["/", { file: join(PUBLIC_DIR, "index.html"), type: "text/html; charset=utf-8" }],
  ["/index.html", { file: join(PUBLIC_DIR, "index.html"), type: "text/html; charset=utf-8" }],
  ["/app.js", { file: join(PUBLIC_DIR, "app.js"), type: "text/javascript; charset=utf-8" }],
  ["/styles.css", { file: join(PUBLIC_DIR, "styles.css"), type: "text/css; charset=utf-8" }],
  ["/data.json", { file: DATA_FILE, type: "application/json; charset=utf-8" }],
]);

const COMPRESSIBLE = new Set([".js", ".css", ".json"]);
// Keyed by path, and re-read whenever the file's mtime moves: the author edits these files and
// reloads, so a cache that never notices would serve the previous page while looking like a
// working one. Two sessions run this repo at once, so this is also how a peer's edit shows up.
const cache = new Map();

function body(route, compress) {
  const { mtimeMs } = statSync(route.file);
  let entry = cache.get(route.file);
  if (!entry || entry.mtimeMs !== mtimeMs) {
    entry = { mtimeMs, raw: readFileSync(route.file) };
    cache.set(route.file, entry);
  }
  if (!compress || !COMPRESSIBLE.has(extname(route.file))) return entry.raw;
  entry.gzip ??= gzipSync(entry.raw);
  return entry.gzip;
}

const server = createServer((request, response) => {
  const pathname = (request.url ?? "/").split("?")[0];
  const route = ROUTES.get(pathname);
  if (!route) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("not found\n");
    return;
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { allow: "GET, HEAD", "content-type": "text/plain; charset=utf-8" });
    response.end("method not allowed\n");
    return;
  }

  const compress = COMPRESSIBLE.has(extname(route.file)) && /gzip/.test(request.headers["accept-encoding"] ?? "");
  let payload;
  try {
    payload = body(route, compress);
  } catch (error) {
    // The data file is written by `just commits-timeline` before it starts this server, so a
    // failure here is a real one and says which file is missing.
    const missing = error.code === "ENOENT";
    response.writeHead(missing ? 503 : 500, { "content-type": "text/plain; charset=utf-8" });
    response.end(missing ? `run 'just commits-timeline' first: ${route.file} is missing\n` : "read failed\n");
    console.error(`commits-timeline: ${pathname}: ${error.message}`);
    return;
  }

  const headers = {
    "content-type": route.type,
    // The data is regenerated on every run; a cached copy would show a stale history.
    "cache-control": pathname === "/data.json" ? "no-store" : "no-cache",
    "x-content-type-options": "nosniff",
    "content-length": String(payload.length),
  };
  if (compress) {
    headers["content-encoding"] = "gzip";
    headers["vary"] = "accept-encoding";
  }
  response.writeHead(200, headers);
  if (request.method === "HEAD") response.end();
  else response.end(payload);
});

// The generator writes the data, and the just recipe runs it first, so a missing file here means a
// direct `node serve.mjs` without one. Say so and exit rather than serving a page that 503s.
try {
  statSync(DATA_FILE);
} catch {
  console.error(`commits-timeline: ${DATA_FILE} is missing; run 'just commits-timeline' first`);
  process.exit(1);
}

server.listen(PORT, HOST, () => {
  writeFileSync(PID_FILE, `${process.pid}\n`);
  console.log(`commits-timeline: http://${HOST}:${PORT}`);
  const origin = tailnetOrigin();
  if (origin) console.log(`commits-timeline: ${origin} (needs 'just commits-timeline-tailnet' once)`);
  else console.log("commits-timeline: tailscale is not running, so tailnet HTTPS is unavailable");
});

function stop() {
  server.close(() => process.exit(0));
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
