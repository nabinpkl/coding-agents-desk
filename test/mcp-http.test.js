const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PORT = "3859";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ax-mcp-"));
const env = Object.assign({}, process.env, {
  ANNOTATE_PORT: PORT,
  ANNOTATE_FILE: path.join(dir, "a.json"),
  ANNOTATE_PIDFILE: path.join(dir, "mcp.pid"),
});

const child = spawn("node", [path.join(__dirname, "..", "mcp-server.js")], { env, stdio: ["ignore", "pipe", "pipe"] });

function post(p, body, headers) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const http = require("node:http");
    const req = http.request({
      host: "127.0.0.1", port: Number(PORT), path: p, method: "POST",
      headers: Object.assign({ "Content-Type": "application/json", "Accept": "application/json, text/event-stream", "Content-Length": Buffer.byteLength(data) }, headers || {}),
    }, (res) => {
      let b = "";
      res.on("data", (c) => { b += c; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function get(p, headers) {
  return new Promise((resolve, reject) => {
    const http = require("node:http");
    const req = http.request({ host: "127.0.0.1", port: Number(PORT), path: p, method: "GET", headers: headers || {} }, (res) => {
      let b = "";
      res.on("data", (c) => { b += c; });
      res.on("end", () => resolve({ status: res.statusCode, body: b }));
    });
    req.on("error", reject);
    req.end();
  });
}

(async () => {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await get("/health");
      if (r.status === 200) break;
    } catch (e) {}
    await new Promise((r) => setTimeout(r, 100));
  }
  const init = await post("/mcp", { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", clientInfo: { name: "t", version: "1" } } });
  assert.equal(init.status, 200);
  assert.equal(JSON.parse(init.body).result.protocolVersion, "2025-03-26");

  const notif = await post("/mcp", { jsonrpc: "2.0", method: "notifications/initialized" });
  assert.equal(notif.status, 202);

  const tools = await post("/mcp", { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  assert.equal(tools.status, 200);
  assert.ok(JSON.parse(tools.body).result.tools.length >= 7);

  const badOrigin = await post("/mcp", { jsonrpc: "2.0", id: 3, method: "ping" }, { Origin: "http://evil.example" });
  assert.equal(badOrigin.status, 403);

  const g = await get("/mcp", { Accept: "text/event-stream" });
  assert.equal(g.status, 405);

  console.log("mcp-http.test.js ok");
  child.kill();
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(0);
})().catch((e) => { console.error(e); try { child.kill(); } catch (x) {} process.exit(1); });
