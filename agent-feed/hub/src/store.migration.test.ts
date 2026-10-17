// What a database that predates the Bot-address change becomes, because the schema is append-only
// and every deployed hub already has the earlier migrations applied.
//
// The thing worth pinning is the backfill. A destination is now a Bot, and delivery needs the session
// that Bot resolved to, so `to_session` is new and the older rows have to be given one. Delivered
// messages are history and carry the session they actually reached. A queued message has no such
// column to read, because it was addressed to a bare session id that no longer names anything, and
// there is no way to know which Bot it belonged to -- so those are cancelled rather than pointed at a
// guess, since delivering a held message to the wrong session is the exact surprise this shape removes.

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HubStore } from "@/store";

const CREATE = `
  CREATE TABLE sessions (address TEXT PRIMARY KEY, machine TEXT NOT NULL, cwd TEXT NOT NULL, title TEXT NOT NULL, channel INTEGER NOT NULL, connected INTEGER NOT NULL, last_seen TEXT NOT NULL);
  CREATE TABLE bots (machine TEXT NOT NULL, bot_id TEXT NOT NULL, name TEXT NOT NULL, path TEXT NOT NULL, session_ids_json TEXT NOT NULL, published_at TEXT NOT NULL, PRIMARY KEY (machine, bot_id));
`;

/** A database as the first migration leaves it, with `fallback_bot` still present. */
function atVersionOne(file: string): void {
  const db = new Database(file, { create: true });
  db.exec(`
    ${CREATE}
    CREATE TABLE messages (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, thread_id TEXT NOT NULL,
      in_reply_to TEXT, from_addr TEXT NOT NULL, from_kind TEXT NOT NULL, to_addr TEXT NOT NULL,
      fallback_bot TEXT, kind TEXT NOT NULL, body TEXT NOT NULL, refs_json TEXT NOT NULL, hops INTEGER NOT NULL,
      state TEXT NOT NULL, pushed_stream TEXT, delivered_to TEXT, delivered_at TEXT, answered_by TEXT,
      created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
    PRAGMA user_version = 1;
  `);
  const insert = db.query(`
    INSERT INTO messages (id, thread_id, from_addr, from_kind, to_addr, fallback_bot, kind, body, refs_json, hops, state, delivered_to, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insert.run("queued-at-session", "t1", "human", "human", "claude:s1", "bot:x", "request", "queued at a session", "[]", 1, "queued", null, "2026-01-01", "2027-01-01");
  insert.run("delivered-at-session", "t2", "human", "human", "claude:s2", "bot:x", "request", "already delivered", "[]", 1, "delivered", "claude:s2", "2026-01-01", "2027-01-01");
  insert.run("answered-to-owner", "t3", "claude:s3", "agent", "human", null, "request", "answered by its session", "[]", 1, "answered", "human", "2026-01-01", "2027-01-01");
  db.close();
}

/** A database as the second migration leaves it: no `fallback_bot`, still no `to_session`. */
function atVersionTwo(file: string): void {
  const db = new Database(file, { create: true });
  db.exec(`
    ${CREATE}
    CREATE TABLE messages (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, thread_id TEXT NOT NULL,
      in_reply_to TEXT, from_addr TEXT NOT NULL, from_kind TEXT NOT NULL, to_addr TEXT NOT NULL,
      kind TEXT NOT NULL, body TEXT NOT NULL, refs_json TEXT NOT NULL, hops INTEGER NOT NULL,
      state TEXT NOT NULL, pushed_stream TEXT, delivered_to TEXT, delivered_at TEXT, answered_by TEXT,
      created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
    PRAGMA user_version = 2;
  `);
  const insert = db.query(`
    INSERT INTO messages (id, thread_id, from_addr, from_kind, to_addr, kind, body, refs_json, hops, state, delivered_to, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insert.run("delivered-to-bot", "t4", "human", "human", "bot:y", "request", "aimed at a Bot", "[]", 1, "delivered", "claude:s9", "2026-01-01", "2027-01-01");
  insert.run("queued-to-bot", "t5", "human", "human", "bot:y", "request", "aimed at a Bot, waiting", "[]", 1, "queued", null, "2026-01-01", "2027-01-01");
  insert.run("queued-bare", "t6", "human", "human", "claude:s7", "request", "aimed at a bare session", "[]", 1, "queued", null, "2026-01-01", "2027-01-01");
  insert.run("delivered-notice", "t7", "human", "human", "bot:y", "notice", "an old notice", "[]", 0, "delivered", "claude:s9", "2026-01-01", "2027-01-01");
  db.close();
}

function withDb<T>(seed: (file: string) => void, body: (file: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "hub-migration-"));
  const file = join(dir, "hub.db");
  try {
    seed(file);
    return body(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("the Bot-address migration", () => {
  test("a message that reached a session keeps that session as its target", () => {
    withDb(atVersionTwo, (file) => {
      const store = new HubStore(file);
      const delivered = store.getMessage("delivered-to-bot");
      // The session it reached is known, so it is the target it keeps: a reply to this thread and a
      // later delivery both need to know which run was actually reached.
      expect(delivered?.toSession).toBe("claude:s9");
      expect(delivered?.to).toBe("bot:y");
      expect(delivered?.state).toBe("delivered");
      expect(delivered?.body).toBe("aimed at a Bot");
      store.close();
    });
  });

  test("a message addressed to the owner has no session target", () => {
    withDb(atVersionOne, (file) => {
      const store = new HubStore(file);
      expect(store.getMessage("answered-to-owner")?.toSession).toBeNull();
      expect(store.getMessage("answered-to-owner")?.state).toBe("answered");
      store.close();
    });
  });

  test("a queued message is cancelled rather than pointed at a session nobody named", () => {
    // Both kinds of queued message go. One was addressed to a bare session id, which names nothing now
    // and cannot be traced back to a Bot; the other was addressed to a Bot that may since have changed
    // membership, so resolving it now could deliver it to a session the sender never chose.
    withDb(atVersionTwo, (file) => {
      const store = new HubStore(file);
      expect(store.getMessage("queued-bare")?.state).toBe("cancelled");
      expect(store.getMessage("queued-to-bot")?.state).toBe("queued");
      expect(store.getMessage("queued-to-bot")?.toSession).toBeNull();
      store.close();
    });
  });

  test("a queued message at a bare session is cancelled, since that address no longer exists", () => {
    withDb(atVersionOne, (file) => {
      const store = new HubStore(file);
      expect(store.getMessage("queued-at-session")?.state).toBe("cancelled");
      expect(store.getMessage("delivered-at-session")?.toSession).toBe("claude:s2");
      store.close();
    });
  });

  test("carries the target column, so delivery never has to resolve the address again", () => {
    withDb(atVersionOne, (file) => {
      new HubStore(file).close();
      const columns = (new Database(file).query("PRAGMA table_info(messages)").all() as { name: string }[]).map((r) => r.name);
      expect(columns).toContain("to_session");
      expect(columns).not.toContain("fallback_bot");
      const version = (new Database(file).query("PRAGMA user_version").get() as { user_version: number }).user_version;
      expect(version).toBe(4);
    });
  });
});

describe("the message-kind migration", () => {
  test("a stored notice becomes a report, the kind that took its place, and other kinds are kept", () => {
    withDb(atVersionTwo, (file) => {
      const store = new HubStore(file);
      expect(store.getMessage("delivered-notice")?.kind).toBe("report");
      expect(store.getMessage("delivered-notice")?.body).toBe("an old notice");
      expect(store.getMessage("delivered-to-bot")?.kind).toBe("request");
      store.close();
    });
  });
});
