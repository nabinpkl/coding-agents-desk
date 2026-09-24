/* JSON file store for annotations. Required by mcp-server.js and tests.
 * No dependencies. All access runs under a lockfile because the daemon,
 * agent-spawned servers, and CLI probes all share this file. */
const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");
const { buildMarkdown } = require("./format.js");

function createStore(file) {
  const f = file || path.join(__dirname, "annotations.json");
  const lockDir = f + ".lock";

  function acquire() {
    const start = Date.now();
    for (;;) {
      try { fs.mkdirSync(lockDir); return; }
      catch (e) { /* held, inspect below */ }
      try {
        if (Date.now() - fs.statSync(lockDir).mtimeMs > 10000) {
          try { fs.rmdirSync(lockDir); } catch (e2) {}
          continue;
        }
      } catch (e3) { continue; }
      if (Date.now() - start > 8000) throw new Error("store busy, try again");
      try { execSync("sleep 0.05"); } catch (e4) {}
    }
  }

  function release() {
    try { fs.rmdirSync(lockDir); } catch (e) {}
  }

  function withLock(fn) {
    acquire();
    try { return fn(); }
    finally { release(); }
  }

  // Raw parse plus in-memory defaults. Persistence of backfilled fields
  // happens on the next mutation inside the same lock.
  function load() {
    let items = [];
    try {
      const d = JSON.parse(fs.readFileSync(f, "utf8"));
      if (Array.isArray(d)) items = d;
    } catch (e) {
      return [];
    }
    items.forEach((r) => {
      if (!r.createdAt) r.createdAt = new Date(0).toISOString();
      if (!r.updatedAt) r.updatedAt = r.createdAt;
      if (!Array.isArray(r.replies)) r.replies = [];
    });
    return items;
  }

  function saveAll(items) {
    fs.writeFileSync(f, JSON.stringify(items, null, 2));
  }

  function nextId(items) {
    return items.length ? Math.max.apply(null, items.map((x) => x.id || 0)) + 1 : 1;
  }

  function matchUrl(r, url) {
    return !url || (r.url || "").indexOf(url) !== -1;
  }

  function add(a) {
    return withLock(() => {
      const items = load();
      const now = new Date().toISOString();
      const rec = {
        id: nextId(items),
        status: "open",
        createdAt: now,
        updatedAt: now,
        resolvedAt: null,
        resolvedBy: null,
        url: a.url || "",
        title: a.title || "",
        text: a.text || "",
        tag: a.tag || "bug",
        metadata: a.metadata || {},
        replies: []
      };
      items.push(rec);
      saveAll(items);
      return rec;
    });
  }

  function list(opts) {
    opts = opts || {};
    return withLock(() => load().filter((r) => {
      if (!matchUrl(r, opts.url)) return false;
      if (opts.status && r.status !== opts.status) return false;
      return true;
    }).sort((a, b) => {
      const t = String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
      return t !== 0 ? t : b.id - a.id;
    }));
  }

  function get(id) {
    return withLock(() => load().find((r) => r.id === Number(id)) || null);
  }

  function resolve(id, by) {
    return withLock(() => {
      const items = load();
      const r = items.find((x) => x.id === Number(id));
      if (!r) return null;
      r.status = "resolved";
      r.resolvedAt = new Date().toISOString();
      r.updatedAt = r.resolvedAt;
      r.resolvedBy = by || "agent";
      saveAll(items);
      return r;
    });
  }

  function reopen(id, by) {
    return withLock(() => {
      const items = load();
      const r = items.find((x) => x.id === Number(id));
      if (!r) return null;
      r.status = "open";
      r.resolvedAt = null;
      r.resolvedBy = null;
      r.updatedAt = new Date().toISOString();
      r.reopenedBy = by || "agent";
      saveAll(items);
      return r;
    });
  }

  function remove(id) {
    return withLock(() => {
      const items = load();
      const kept = items.filter((x) => x.id !== Number(id));
      if (kept.length === items.length) return false;
      saveAll(kept);
      return true;
    });
  }

  function clear(url) {
    return withLock(() => {
      const items = load();
      const kept = items.filter((r) => !matchUrl(r, url));
      const n = items.length - kept.length;
      if (n) saveAll(kept);
      return n;
    });
  }

  function addReply(id, reply) {
    return withLock(() => {
      const items = load();
      const r = items.find((x) => x.id === Number(id));
      if (!r) return null;
      if (!Array.isArray(r.replies)) r.replies = [];
      r.replies.push({ by: (reply && reply.by) || "agent", text: (reply && reply.text) || "", at: new Date().toISOString() });
      r.updatedAt = new Date().toISOString();
      saveAll(items);
      return r;
    });
  }

  function addScreenshot(id, shot) {
    return withLock(() => {
      const items = load();
      const r = items.find((x) => x.id === Number(id));
      if (!r) return null;
      r.metadata = r.metadata || {};
      r.metadata.screenshot = shot.file;
      r.coverage = { scanned: (shot.coverage && shot.coverage.scanned) || 0, items: ((shot.coverage && shot.coverage.items) || []).slice(0, 200) };
      r.updatedAt = new Date().toISOString();
      saveAll(items);
      return r;
    });
  }

  function brief(url) {
    const items = list({ url: url, status: "open" });
    return buildMarkdown(
      items.map((r) => ({ text: r.text, metadata: Object.assign({}, r.metadata, { tag: r.tag }) })),
      { url: url || "all pages", title: "" }
    );
  }

  return { add: add, list: list, get: get, resolve: resolve, reopen: reopen, remove: remove, clear: clear, addReply: addReply, addScreenshot: addScreenshot, brief: brief, file: f };
}

module.exports = { createStore: createStore };
