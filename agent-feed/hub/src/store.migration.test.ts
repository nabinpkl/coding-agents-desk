// What a database that predates the Bot-label change becomes, because the schema is append-only
// and every deployed hub already has migration 1 applied.
//
// The one thing worth pinning is the cancellation: a message still queued at a `bot:` recipient was
// addressed under a rule that no longer exists, and leaving it queued would hold it against an
// address `send` now refuses. Delivered messages are history and are left alone.

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HubStore } from "@/store";

/** A database as migration 1 leaves it: every table, and `user_version` = 1. */
function atVersionOne(): string {
  const dir = mkdtempSync(join(tmpdir(), "hub-migration-"));
  const file = join(dir, "hub.db");
  const db = new Database(file, { create: true });
  db.exec(`
    CREATE TABLE sessions (address TEXT PRIMARY KEY, machine TEXT NOT NULL, cwd TEXT NOT NULL, title TEXT NOT NULL, channel INTEGER NOT NULL, connected INTEGER NOT NULL, last_seen TEXT NOT NULL);
    CREATE TABLE bots (machine TEXT NOT NULL, bot_id TEXT NOT NULL, name TEXT NOT NULL, path TEXT NOT NULL, session_ids_json TEXT NOT NULL, published_at TEXT NOT NULL, PRIMARY KEY (machine, bot_id));
    CREATE TABLE messages (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, thread_id TEXT NOT NULL,
      in_reply_to TEXT, from_addr TEXT NOT NULL, from_kind TEXT NOT NULL, to_addr TEXT NOT NULL,
      fallback_bot TEXT, kind TEXT NOT NULL, body TEXT NOT NULL, refs_json TEXT NOT NULL, hops INTEGER NOT NULL,
      state TEXT NOT NULL, pushed_stream TEXT, delivered_to TEXT, delivered_at TEXT, answered_by TEXT,
      created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
    CREATE INDEX messages_thread ON messages (thread_id, seq);
    CREATE INDEX messages_state ON messages (state, seq);
    CREATE INDEX messages_from ON messages (from_addr, created_at);
    PRAGMA user_version = 1;
  `);
  const insert = db.query(`
    INSERT INTO messages (id, thread_id, from_addr, from_kind, to_addr, fallback_bot, kind, body, refs_json, hops, state, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insert.run("queued-at-bot", "t1", "human", "human", "bot:x", "bot:x", "request", "queued at a Bot", "[]", 1, "queued", "2026-01-01", "2027-01-01");
  insert.run("queued-at-session", "t2", "human", "human", "claude:s1", "bot:x", "request", "queued at a session", "[]", 1, "queued", "2026-01-01", "2027-01-01");
  insert.run("delivered-at-bot", "t3", "human", "human", "bot:y", "bot:y", "request", "already delivered", "[]", 1, "delivered", "2026-01-01", "2027-01-01");
  db.close();
  return file;
}

describe("the Bot-label migration", () => {
  test("cancels what is still queued at a Bot, keeps delivered history, and waits for sessions", () => {
    const file = atVersionOne();
    try {
      const store = new HubStore(file);
      // A `bot:` recipient is an address `send` now refuses, so holding this message would wait on
      // a rule that no longer exists.
      expect(store.getMessage("queued-at-bot")?.state).toBe("cancelled");
      // The session-addressed message is the normal case and must survive the rebuild intact.
      expect(store.getMessage("queued-at-session")?.state).toBe("queued");
      // Delivered messages are history, not pending work, so they are left exactly as they were.
      expect(store.getMessage("delivered-at-bot")?.state).toBe("delivered");
      expect(store.getMessage("delivered-at-bot")?.body).toBe("already delivered");
    } finally {
      new Database(file).close();
      rmSync(file, { force: true });
      rmSync(join(file, ".."), { recursive: true, force: true });
    }
  });

  test("drops the fallback column, so nothing can reroute a message to a sibling session", () => {
    const file = atVersionOne();
    try {
      new HubStore(file).close();
      const columns = (new Database(file).query("PRAGMA table_info(messages)").all() as { name: string }[])
        .map((row) => row.name);
      expect(columns).not.toContain("fallback_bot");
      expect(columns).toContain("to_addr");
    } finally {
      new Database(file).close();
      rmSync(file, { force: true });
      rmSync(join(file, ".."), { recursive: true, force: true });
    }
  });
});
