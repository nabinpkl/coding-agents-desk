/* MCP stdio server plus localhost ingest bridge. No dependencies.
 * Run: node mcp-server.js (stdio for the agent, HTTP on ANNOTATE_PORT for the extension).
 * Annotations carry their page URL. Agents filter by `url` substring to find
 * their own site. Trust based: no per-agent auth in v1. */
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { execSync } = require("node:child_process");
const { createStore } = require("./store.js");

const PIDFILE = process.env.ANNOTATE_PIDFILE || path.join(__dirname, "mcp-server.pid");
const ROLE = process.env.ANNOTATE_DAEMON === "1" ? "daemon" : "stdio";

function claimSingleton() {
  let prev = null;
  try {
    const d = JSON.parse(fs.readFileSync(PIDFILE, "utf8"));
    if (d && Number(d.pid)) prev = d;
  } catch (e) { prev = null; }
  if (prev && prev.pid !== process.pid && prev.role !== "daemon" && ROLE !== "daemon") {
    let alive = false;
    try { process.kill(prev.pid, 0); alive = true; } catch (e) { alive = false; }
    if (alive) {
      let ours = false;
      try {
        ours = execSync("ps -p " + Number(prev.pid) + " -o args=", { timeout: 2000 }).toString().indexOf("mcp-server.js") !== -1;
      } catch (e) { ours = false; }
      if (ours) {
        try { process.kill(prev.pid, "SIGTERM"); console.error("[agentdesk-annotator] retired predecessor " + prev.pid); }
        catch (e) { /* already gone */ }
      }
    }
  }
  try { fs.writeFileSync(PIDFILE, JSON.stringify({ pid: process.pid, role: ROLE })); } catch (e) {}
  process.on("exit", () => {
    try {
      const cur = JSON.parse(fs.readFileSync(PIDFILE, "utf8"));
      if (cur && cur.pid === process.pid) fs.unlinkSync(PIDFILE);
    } catch (e) {}
  });
}

claimSingleton();

const PORT = Number(process.env.ANNOTATE_PORT || 3847);
const TOKEN = process.env.ANNOTATE_TOKEN || "";
const store = createStore(process.env.ANNOTATE_FILE);

const MCP_VERSIONS = ["2026-07-28", "2025-11-25", "2025-03-26", "2024-11-05"];
const MCP_DEFAULT_VERSION = "2025-03-26";

function bearerOf(req) {
  const h = req.headers && (req.headers.authorization || req.headers.Authorization);
  if (!h) return "";
  const m = /^Bearer\s+(.+)$/.exec(String(h).trim());
  return m ? m[1] : "";
}

function mcpHttpError(res, httpCode, id, code, message) {
  res.writeHead(httpCode, { "Content-Type": "application/json" });
  if (id === undefined || id === null) {
    res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: code, message: message } }));
    return;
  }
  res.end(JSON.stringify({ jsonrpc: "2.0", id: id, error: { code: code, message: message } }));
}

const TOOLS = [
  {
    name: "agentdesk-annotator_list",
    description: "List annotations, most recently updated first. Pass url (substring of the page URL) to scope to one site, and status open or resolved. Each record carries createdAt, updatedAt, and resolvedBy (agent versus user) so you can tell who marked it done.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Substring filter on the recorded page URL." },
        status: { type: "string", enum: ["open", "resolved"] }
      }
    }
  },
  {
    name: "agentdesk-annotator_get",
    description: "Full detail of one annotation: comment, selector, DOM path, styles, bounding box.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "number", description: "Annotation id from agentdesk-annotator_list." } },
      required: ["id"]
    }
  },
  {
    name: "agentdesk-annotator_brief",
    description: "Markdown brief of open annotations for a URL, ready to work from. Omit url for everything open.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", description: "Substring filter on the recorded page URL." } }
    }
  },
  {
    name: "agentdesk-annotator_screenshot",
    description: "Element screenshot plus a text summary of covered DOM nodes. Returns image content the agent sees directly.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "number", description: "Annotation id from agentdesk-annotator_list." } },
      required: ["id"]
    }
  },
  {
    name: "agentdesk-annotator_elements",
    description: "Bounded, filterable dump of DOM nodes covered by the element screenshot. Filter by substring or tag, cap with limit.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "Annotation id from agentdesk-annotator_list." },
        contains: { type: "string", description: "Substring matched against selector, tag, and text." },
        tag: { type: "string", description: "Exact tag name, e.g. BUTTON." },
        limit: { type: "number", description: "Max nodes returned, default 40." }
      },
      required: ["id"]
    }
  },
  {
    name: "agentdesk-annotator_resolve",
    description: "Mark an annotation fixed after applying the change. Records resolvedBy as agent, distinct from a user resolution. The panel shows who resolved it. Optional message is stored as an agent reply shown in the panel.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number" },
        message: { type: "string", description: "Optional reply shown in the panel, e.g. what was fixed." }
      },
      required: ["id"]
    }
  },
  {
    name: "agentdesk-annotator_reopen",
    description: "Acknowledged but unresolved: optional why message stays on the item while it remains open. Use when confused or blocked instead of resolving.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number" },
        message: { type: "string", description: "Why it is unresolved, shown in the panel." }
      },
      required: ["id"]
    }
  }
];

function textResult(obj) {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] };
}

function callTool(name, args) {
  args = args || {};
  switch (name) {
    case "agentdesk-annotator_list":
      return textResult(store.list({ url: args.url, status: args.status }));
    case "agentdesk-annotator_get": {
      const r = store.get(args.id);
      return r ? textResult(r) : textResult({ error: "not found: " + args.id });
    }
    case "agentdesk-annotator_brief":
      return { content: [{ type: "text", text: store.brief(args.url) }] };
    case "agentdesk-annotator_screenshot": {
      const r = store.get(args.id);
      if (!r || !r.metadata || !r.metadata.screenshot) return textResult({ error: "no screenshot for: " + args.id });
      const fp = path.join(__dirname, "screenshots", path.basename(r.metadata.screenshot));
      let data = null;
      try { data = fs.readFileSync(fp).toString("base64"); } catch (e) { data = null; }
      if (!data) return textResult({ error: "screenshot file missing for: " + args.id });
      const cov = r.coverage || { scanned: 0, items: [] };
      return {
        content: [
          { type: "image", data: data, mimeType: "image/jpeg" },
          { type: "text", text: "Element screenshot for annotation " + r.id + ". " + cov.items.length + " of " + cov.scanned + " covered nodes stored. Use agentdesk-annotator_elements to filter the dump." }
        ]
      };
    }
    case "agentdesk-annotator_elements": {
      const r = store.get(args.id);
      if (!r) return textResult({ error: "not found: " + args.id });
      const items = ((r.coverage && r.coverage.items) || []).filter((n) => {
        if (args.tag && n.tag !== String(args.tag).toUpperCase()) return false;
        if (args.contains) {
          const hay = ((n.selector || "") + " " + (n.tag || "") + " " + (n.text || "")).toLowerCase();
          if (hay.indexOf(String(args.contains).toLowerCase()) === -1) return false;
        }
        return true;
      });
      const limit = Math.min(Math.max(Number(args.limit) || 40, 1), 200);
      return textResult({ total: ((r.coverage && r.coverage.items) || []).length, returned: Math.min(limit, items.length), items: items.slice(0, limit) });
    }
    case "agentdesk-annotator_resolve": {
      const r = store.resolve(args.id);
      if (!r) return textResult({ error: "not found: " + args.id });
      if (args.message) store.addReply(args.id, { by: "agent", text: args.message });
      return textResult(store.get(args.id));
    }
    case "agentdesk-annotator_reopen": {
      const r = store.reopen(args.id);
      if (!r) return textResult({ error: "not found: " + args.id });
      if (args.message) store.addReply(args.id, { by: "agent", text: args.message });
      return textResult(store.get(args.id));
    }
    default:
      throw new Error("unknown tool: " + name);
  }
}

function handleMessage(msg) {
  if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0") return null;
  if (msg.method === "notifications/initialized" || (msg.method || "").indexOf("notifications/") === 0) {
    return null;
  }
  const id = msg.id;
  try {
    let result;
    switch (msg.method) {
      case "initialize": {
        const asked = msg.params && msg.params.protocolVersion;
        result = {
          protocolVersion: MCP_VERSIONS.indexOf(asked) !== -1 ? asked : MCP_DEFAULT_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "agentdesk-annotator", version: "0.2.0" }
        };
        break;
      }
      case "ping":
        result = {};
        break;
      case "tools/list":
        result = { tools: TOOLS };
        break;
      case "tools/call":
        result = callTool(msg.params && msg.params.name, msg.params && msg.params.arguments);
        break;
      default:
        throw new Error("unknown method: " + msg.method);
    }
    return id == null ? null : { jsonrpc: "2.0", id: id, result: result };
  } catch (e) {
    return id == null ? null : { jsonrpc: "2.0", id: id, error: { code: -32603, message: String(e && e.message || e) } };
  }
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let out = null;
    try {
      out = handleMessage(JSON.parse(line));
    } catch (e) {
      out = { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } };
    }
    if (out) process.stdout.write(JSON.stringify(out) + "\n");
  }
});

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 1024 * 1024) reject(new Error("body too large"));
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function originAllowed(req) {
  const o = req.headers && (req.headers.origin || req.headers.Origin);
  if (!o) return true;
  let u = null;
  try { u = new URL(String(o)); } catch (e) { return false; }
  const host = u.hostname || "";
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") return true;
  if (host === "claude.ai" || host.endsWith(".claude.ai")) return true;
  if (host === "anthropic.com" || host.endsWith(".anthropic.com")) return true;
  const extra = String(process.env.ANNOTATE_ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  for (const e of extra) {
    if (e === host || (e.charAt(0) === "*" && host.endsWith(e.slice(1)))) return true;
    try {
      const eu = new URL(e.indexOf("://") === -1 ? "https://" + e : e);
      if (eu.hostname === host) return true;
    } catch (err) {}
  }
  return false;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Accept, MCP-Protocol-Version, Mcp-Session-Id, Last-Event-ID");
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
  if ((url.pathname === "/mcp" || url.pathname === "/mcp/") && !originAllowed(req)) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "origin not allowed" }));
    return;
  }
  try {
    if ((url.pathname === "/mcp" || url.pathname === "/mcp/") && req.method === "GET") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "SSE stream not offered; use POST" }));
      return;
    } else if ((url.pathname === "/mcp" || url.pathname === "/mcp/") && req.method === "DELETE") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "stateless mode; no session to delete" }));
      return;
    } else if ((url.pathname === "/mcp" || url.pathname === "/mcp/") && req.method === "POST") {
      if (TOKEN && bearerOf(req) !== TOKEN) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      let body = null;
      try { body = JSON.parse(await readBody(req)); }
      catch (e) { mcpHttpError(res, 400, null, -32700, "parse error"); return; }
      const proto = req.headers["mcp-protocol-version"] || req.headers["MCP-Protocol-Version"];
      const items = Array.isArray(body) ? body : [body];
      const outs = [];
      for (const m of items) {
        let out = null;
        try {
          if (m && m.method === "initialize") {
            const asked = m.params && m.params.protocolVersion;
            const ver = MCP_VERSIONS.indexOf(asked) !== -1 ? asked : MCP_DEFAULT_VERSION;
            out = m.id == null ? null : { jsonrpc: "2.0", id: m.id, result: { protocolVersion: ver, capabilities: { tools: {} }, serverInfo: { name: "agentdesk-annotator", version: "0.2.0" } } };
          } else {
            out = handleMessage(m);
          }
        } catch (e) {
          out = (m && m.id != null) ? { jsonrpc: "2.0", id: m.id, error: { code: -32603, message: String(e && e.message || e) } } : null;
        }
        if (out) outs.push(out);
      }
      if (proto && MCP_VERSIONS.indexOf(String(proto)) !== -1) res.setHeader("MCP-Protocol-Version", String(proto));
      if (outs.length === 0) { res.writeHead(202); res.end(); return; }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(Array.isArray(body) ? outs : outs[0]));
      return;
    } else if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } else if (req.method === "GET" && url.pathname === "/annotations") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(store.list({ url: url.searchParams.get("url") || undefined, status: url.searchParams.get("status") || undefined })));
    } else if (req.method === "POST" && url.pathname === "/ingest") {
      const a = JSON.parse(await readBody(req));
      if (!a.text) throw new Error("text required");
      const rec = store.add(a);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(rec));
    } else if (req.method === "POST" && url.pathname === "/resolve") {
      const b = JSON.parse(await readBody(req));
      const r = store.resolve(b.id, b.by || "user");
      if (!r) throw new Error("not found: " + b.id);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(r));
    } else if (req.method === "POST" && url.pathname === "/reopen") {
      const b = JSON.parse(await readBody(req));
      const r = store.reopen(b.id, b.by || "user");
      if (!r) throw new Error("not found: " + b.id);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(r));
    } else if (req.method === "POST" && url.pathname === "/reply") {
      const b = JSON.parse(await readBody(req));
      if (!b.text) throw new Error("text required");
      const r = store.addReply(b.id, { by: b.by || "user", text: b.text });
      if (!r) throw new Error("not found: " + b.id);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(r));
    } else if (req.method === "POST" && url.pathname === "/screenshot") {
      const b = JSON.parse(await readBody(req));
      const r = store.get(b.id);
      if (!r) throw new Error("not found: " + b.id);
      const m = /^data:(image\/\w+);base64,(.+)$/.exec(b.image || "");
      if (!m) throw new Error("image dataUrl required");
      const dir = path.join(__dirname, "screenshots");
      fs.mkdirSync(dir, { recursive: true });
      const file = "shot-" + r.id + (m[1] === "image/png" ? ".png" : ".jpg");
      fs.writeFileSync(path.join(dir, file), Buffer.from(m[2], "base64"));
      const upd = store.addScreenshot(r.id, { file: file, coverage: b.coverage || {} });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, file: file, coverage: upd.coverage }));
    } else if (req.method === "POST" && url.pathname === "/clear") {
      const b = JSON.parse(await readBody(req));
      if (!b.url) throw new Error("url required");
      const n = store.clear(b.url);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, removed: n }));
    } else if (req.method === "GET" && /^\/shot\/[\w.-]+$/.test(url.pathname)) {
      const name = path.basename(url.pathname);
      if (!/^shot-\d+\.(jpg|jpeg|png)$/.test(name)) { res.writeHead(400); res.end("bad name"); return; }
      const fp = path.join(__dirname, "screenshots", name);
      let buf = null;
      try { buf = fs.readFileSync(fp); } catch (e) { buf = null; }
      if (!buf) { res.writeHead(404); res.end("not found"); return; }
      res.writeHead(200, { "Content-Type": name.endsWith(".png") ? "image/png" : "image/jpeg" });
      res.end(buf);
      return;
    } else if (req.method === "DELETE" && /^\/annotations\/\d+$/.test(url.pathname)) {
      const id = Number(url.pathname.split("/")[2]);
      if (!store.remove(id)) throw new Error("not found: " + id);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } else {
      res.writeHead(404); res.end("not found");
    }
  } catch (e) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: String(e && e.message || e) }));
  }
});

server.on("error", (err) => {
  // Another instance (e.g. the launchd daemon) already owns the bridge port.
  // Stay alive for stdio MCP; both share the same annotations file.
  console.error("[agentdesk-annotator] bridge unavailable (" + (err && err.code) + "), stdio only");
});

server.listen(PORT, "127.0.0.1", () => {
  console.error("[agentdesk-annotator] bridge on http://127.0.0.1:" + PORT);
});
