// The only module that touches SQLite. Rows in, wire shapes out.

import { Database } from "bun:sqlite";
import type {
  Message,
  MessageAddress,
  MessageKind,
  MessageRef,
  MessageState,
  PublishedBot,
  SenderKind,
  SessionAddress,
} from "@agentdesk/agent-feed-wire";

/** Ordered schema migrations; index + 1 is the PRAGMA user_version it produces. Append only. */
const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE sessions (
    address    TEXT PRIMARY KEY,
    machine    TEXT NOT NULL,
    cwd        TEXT NOT NULL,
    title      TEXT NOT NULL,
    channel    INTEGER NOT NULL,
    connected  INTEGER NOT NULL,
    last_seen  TEXT NOT NULL
  );

  CREATE TABLE bots (
    machine          TEXT NOT NULL,
    bot_id           TEXT NOT NULL,
    name             TEXT NOT NULL,
    path             TEXT NOT NULL,
    session_ids_json TEXT NOT NULL,
    published_at     TEXT NOT NULL,
    PRIMARY KEY (machine, bot_id)
  );

  CREATE TABLE messages (
    seq           INTEGER PRIMARY KEY AUTOINCREMENT,
    id            TEXT NOT NULL UNIQUE,
    thread_id     TEXT NOT NULL,
    in_reply_to   TEXT,
    from_addr     TEXT NOT NULL,
    from_kind     TEXT NOT NULL CHECK (from_kind IN ('human', 'agent')),
    to_addr       TEXT NOT NULL,
    kind          TEXT NOT NULL CHECK (kind IN ('request', 'notice', 'reply')),
    body          TEXT NOT NULL,
    refs_json     TEXT NOT NULL,
    hops          INTEGER NOT NULL,
    state         TEXT NOT NULL CHECK (state IN ('queued', 'pushed', 'delivered', 'answered', 'expired', 'cancelled')),
    pushed_stream TEXT,
    delivered_to  TEXT,
    delivered_at  TEXT,
    answered_by   TEXT,
    created_at    TEXT NOT NULL,
    expires_at    TEXT NOT NULL
  );
  CREATE INDEX messages_thread ON messages (thread_id, seq);
  CREATE INDEX messages_state ON messages (state, seq);
  CREATE INDEX messages_from ON messages (from_addr, created_at);
  `,
  // A Bot stopped being a delivery fallback when it stopped being a destination. `fallback_bot` let a
  // message addressed to one run be rerouted at a sibling, so a message could land in a run nobody
  // named; a message now waits for the session it names. SQLite cannot drop a column, so the table is
  // rebuilt, which is why this is a migration and not an edit to the first one. Any message still
  // holding a `bot:` recipient was a message whose address is now refused, so they are cancelled
  // rather than left queued against a rule that no longer exists.
  `
  UPDATE messages SET state = 'cancelled' WHERE to_addr LIKE 'bot:%' AND state IN ('queued', 'pushed');

  CREATE TABLE messages_without_fallback (
    seq           INTEGER PRIMARY KEY AUTOINCREMENT,
    id            TEXT NOT NULL UNIQUE,
    thread_id     TEXT NOT NULL,
    in_reply_to   TEXT,
    from_addr     TEXT NOT NULL,
    from_kind     TEXT NOT NULL CHECK (from_kind IN ('human', 'agent')),
    to_addr       TEXT NOT NULL,
    kind          TEXT NOT NULL CHECK (kind IN ('request', 'notice', 'reply')),
    body          TEXT NOT NULL,
    refs_json     TEXT NOT NULL,
    hops          INTEGER NOT NULL,
    state         TEXT NOT NULL CHECK (state IN ('queued', 'pushed', 'delivered', 'answered', 'expired', 'cancelled')),
    pushed_stream TEXT,
    delivered_to  TEXT,
    delivered_at  TEXT,
    answered_by   TEXT,
    created_at    TEXT NOT NULL,
    expires_at    TEXT NOT NULL
  );
  INSERT INTO messages_without_fallback
    SELECT seq, id, thread_id, in_reply_to, from_addr, from_kind, to_addr, kind, body, refs_json,
           hops, state, pushed_stream, delivered_to, delivered_at, answered_by, created_at, expires_at
    FROM messages;
  DROP TABLE messages;
  ALTER TABLE messages_without_fallback RENAME TO messages;
  CREATE INDEX messages_thread ON messages (thread_id, seq);
  CREATE INDEX messages_state ON messages (state, seq);
  CREATE INDEX messages_from ON messages (from_addr, created_at);
  `,
  // A destination is now a Bot, and a Bot with several sessions does not say which one should get the
  // message, so the session is resolved once when the message is accepted and stored here. Delivery
  // then pushes to the session the sender's address named rather than resolving the Bot again, which
  // matters twice over: a Bot whose membership changes between accepting and delivering cannot move a
  // queued message to a session nobody chose, and a reply to a session the owner has since taken out of
  // a Bot still reaches the run that was actually answered. SQLite cannot add a NOT NULL column to a
  // populated table without a default, and the default cannot be a real session, so the table is
  // rebuilt like the last migration. `to_session` is backfilled from `delivered_to` for delivered
  // messages, which is the session each one actually reached, and NULL for anything still queued: a
  // queued message predating this migration was addressed to a bare session id that no longer parses
  // as an address, and there is no way to know which Bot it belonged to, so those are cancelled rather
  // than delivered to a guess.
  `
  UPDATE messages SET state = 'cancelled'
    WHERE state IN ('queued', 'pushed') AND to_addr NOT LIKE 'bot:%';

  CREATE TABLE messages_with_target (
    seq           INTEGER PRIMARY KEY AUTOINCREMENT,
    id            TEXT NOT NULL UNIQUE,
    thread_id     TEXT NOT NULL,
    in_reply_to   TEXT,
    from_addr     TEXT NOT NULL,
    from_kind     TEXT NOT NULL CHECK (from_kind IN ('human', 'agent')),
    to_addr       TEXT NOT NULL,
    to_session    TEXT,
    kind          TEXT NOT NULL CHECK (kind IN ('request', 'notice', 'reply')),
    body          TEXT NOT NULL,
    refs_json     TEXT NOT NULL,
    hops          INTEGER NOT NULL,
    state         TEXT NOT NULL CHECK (state IN ('queued', 'pushed', 'delivered', 'answered', 'expired', 'cancelled')),
    pushed_stream TEXT,
    delivered_to  TEXT,
    delivered_at  TEXT,
    answered_by   TEXT,
    created_at    TEXT NOT NULL,
    expires_at    TEXT NOT NULL
  );
  INSERT INTO messages_with_target
    SELECT seq, id, thread_id, in_reply_to, from_addr, from_kind, to_addr,
           CASE WHEN state IN ('delivered', 'answered') AND delivered_to LIKE 'claude:%'
                  THEN delivered_to
                WHEN state IN ('delivered', 'answered') AND delivered_to LIKE 'opencode:%'
                  THEN delivered_to
                ELSE NULL END,
           kind, body, refs_json, hops, state, pushed_stream, delivered_to, delivered_at, answered_by,
           created_at, expires_at
    FROM messages;
  DROP TABLE messages;
  ALTER TABLE messages_with_target RENAME TO messages;
  CREATE INDEX messages_thread ON messages (thread_id, seq);
  CREATE INDEX messages_state ON messages (state, seq);
  CREATE INDEX messages_from ON messages (from_addr, created_at);
  CREATE INDEX messages_to_session ON messages (to_session, state);
  `,
  // A sender now says what it wants back: a request (do this), a question (tell me) or a report
  // (information for your judgement). A notice was the FYI that a report now is, and took no reply
  // the same way, so stored notices become reports. The kind sits in a CHECK, which SQLite cannot
  // alter, so the table is rebuilt like the migrations before it.
  `
  CREATE TABLE messages_with_kinds (
    seq           INTEGER PRIMARY KEY AUTOINCREMENT,
    id            TEXT NOT NULL UNIQUE,
    thread_id     TEXT NOT NULL,
    in_reply_to   TEXT,
    from_addr     TEXT NOT NULL,
    from_kind     TEXT NOT NULL CHECK (from_kind IN ('human', 'agent')),
    to_addr       TEXT NOT NULL,
    to_session    TEXT,
    kind          TEXT NOT NULL CHECK (kind IN ('request', 'question', 'report', 'reply')),
    body          TEXT NOT NULL,
    refs_json     TEXT NOT NULL,
    hops          INTEGER NOT NULL,
    state         TEXT NOT NULL CHECK (state IN ('queued', 'pushed', 'delivered', 'answered', 'expired', 'cancelled')),
    pushed_stream TEXT,
    delivered_to  TEXT,
    delivered_at  TEXT,
    answered_by   TEXT,
    created_at    TEXT NOT NULL,
    expires_at    TEXT NOT NULL
  );
  INSERT INTO messages_with_kinds
    SELECT seq, id, thread_id, in_reply_to, from_addr, from_kind, to_addr, to_session,
           CASE kind WHEN 'notice' THEN 'report' ELSE kind END,
           body, refs_json, hops, state, pushed_stream, delivered_to, delivered_at, answered_by,
           created_at, expires_at
    FROM messages;
  DROP TABLE messages;
  ALTER TABLE messages_with_kinds RENAME TO messages;
  CREATE INDEX messages_thread ON messages (thread_id, seq);
  CREATE INDEX messages_state ON messages (state, seq);
  CREATE INDEX messages_from ON messages (from_addr, created_at);
  CREATE INDEX messages_to_session ON messages (to_session, state);
  `,
];

interface MessageRow {
  id: string;
  thread_id: string;
  in_reply_to: string | null;
  from_addr: string;
  from_kind: string;
  to_addr: string;
  to_session: string | null;
  kind: string;
  body: string;
  refs_json: string;
  hops: number;
  state: string;
  pushed_stream: string | null;
  delivered_to: string | null;
  delivered_at: string | null;
  answered_by: string | null;
  created_at: string;
  expires_at: string;
}

export interface StoredMessage extends Message {
  pushedStream: string | null;
  /** The session `to` resolved to when the message was accepted, or null when addressed to the owner. */
  toSession: SessionAddress | null;
}

export interface SessionRow {
  address: SessionAddress;
  machine: string;
  cwd: string;
  title: string;
  channel: boolean;
  connected: boolean;
  lastSeen: string;
}

export interface BotRow {
  machine: string;
  botId: string;
  name: string;
  path: string;
  sessionIds: string[];
  publishedAt: string;
}

export interface NewMessage {
  id: string;
  threadId: string;
  inReplyTo: string | null;
  from: SessionAddress | "human";
  fromKind: SenderKind;
  to: MessageAddress;
  /** The session `to` resolved to when the message was accepted, or null when addressed to the owner. */
  toSession: SessionAddress | null;
  kind: MessageKind;
  body: string;
  refs: MessageRef[];
  hops: number;
  state: MessageState;
  deliveredTo: SessionAddress | "human" | null;
  deliveredAt: string | null;
  createdAt: string;
  expiresAt: string;
}

function toMessage(row: MessageRow): StoredMessage {
  return {
    id: row.id,
    threadId: row.thread_id,
    inReplyTo: row.in_reply_to,
    from: row.from_addr as SessionAddress | "human",
    fromKind: row.from_kind as SenderKind,
    to: row.to_addr as MessageAddress,
    toSession: row.to_session as SessionAddress | null,
    kind: row.kind as MessageKind,
    body: row.body,
    refs: JSON.parse(row.refs_json) as MessageRef[],
    hops: row.hops,
    state: row.state as MessageState,
    pushedStream: row.pushed_stream,
    deliveredTo: row.delivered_to as SessionAddress | "human" | null,
    deliveredAt: row.delivered_at,
    answeredBy: row.answered_by,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

/** The wire shape, without the hub-internal fields. */
export function publicMessage(message: StoredMessage): Message {
  const { pushedStream: _stream, ...rest } = message;
  return rest;
}

export class HubStore {
  private readonly db: Database;

  constructor(file: string) {
    this.db = new Database(file, { create: true, strict: true });
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  private migrate(): void {
    const { user_version: version } = this.db.query("PRAGMA user_version").get() as { user_version: number };
    for (let i = version; i < MIGRATIONS.length; i++) {
      this.db.transaction(() => {
        this.db.exec(MIGRATIONS[i]!);
        this.db.exec(`PRAGMA user_version = ${i + 1}`);
      })();
    }
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  close(): void {
    this.db.close();
  }

  // Messages

  insertMessage(m: NewMessage): StoredMessage {
    this.db.query(`
      INSERT INTO messages (id, thread_id, in_reply_to, from_addr, from_kind, to_addr, to_session, kind, body, refs_json, hops, state, delivered_to, delivered_at, created_at, expires_at)
      VALUES ($id, $threadId, $inReplyTo, $from, $fromKind, $to, $toSession, $kind, $body, $refs, $hops, $state, $deliveredTo, $deliveredAt, $createdAt, $expiresAt)
    `).run({
      id: m.id,
      threadId: m.threadId,
      inReplyTo: m.inReplyTo,
      from: m.from,
      fromKind: m.fromKind,
      to: m.to,
      toSession: m.toSession,
      kind: m.kind,
      body: m.body,
      refs: JSON.stringify(m.refs),
      hops: m.hops,
      state: m.state,
      deliveredTo: m.deliveredTo,
      deliveredAt: m.deliveredAt,
      createdAt: m.createdAt,
      expiresAt: m.expiresAt,
    });
    return this.getMessage(m.id)!;
  }

  getMessage(id: string): StoredMessage | undefined {
    const row = this.db.query("SELECT * FROM messages WHERE id = ?").get(id) as MessageRow | null;
    return row ? toMessage(row) : undefined;
  }

  thread(threadId: string): StoredMessage[] {
    return (this.db.query("SELECT * FROM messages WHERE thread_id = ? ORDER BY seq").all(threadId) as MessageRow[]).map(toMessage);
  }

  threadSize(threadId: string): number {
    return (this.db.query("SELECT count(*) AS n FROM messages WHERE thread_id = ?").get(threadId) as { n: number }).n;
  }

  sentSince(from: SessionAddress | "human", since: string): number {
    return (this.db.query("SELECT count(*) AS n FROM messages WHERE from_addr = ? AND created_at >= ?").get(from, since) as { n: number }).n;
  }

  /** Everything still waiting for a session, oldest first. */
  queued(): StoredMessage[] {
    return (this.db.query("SELECT * FROM messages WHERE state = 'queued' ORDER BY seq").all() as MessageRow[]).map(toMessage);
  }

  /**
   * Messages to or from any of these sessions, newest thread activity first, whole threads.
   *
   * Matching is on the session rather than the address throughout, because a message addressed to a Bot
   * carries the Bot in `to_addr` and the session it resolved to in `to_session`, and a reader asking
   * "what reached this session" means the session column. `to_addr` is matched too so a message
   * addressed to a Bot shows up for a member that has not been reached yet.
   */
  threadsFor(sessions: string[], bots: string[], limit: number): StoredMessage[][] {
    const all = [...sessions, ...bots];
    const marks = all.map(() => "?").join(",");
    const ids = this.db.query(`
      SELECT thread_id, max(seq) AS last FROM messages
      WHERE from_addr IN (${marks}) OR to_session IN (${marks}) OR delivered_to IN (${marks}) OR to_addr IN (${marks})
      GROUP BY thread_id ORDER BY last DESC LIMIT ?
    `).all(...all, ...all, ...all, ...all, limit) as { thread_id: string }[];
    return ids.map(({ thread_id }) => this.thread(thread_id));
  }

  /** Messages that reached, or wait for, one session and have not been answered or closed. */
  openFor(session: SessionAddress): StoredMessage[] {
    return (this.db.query(`
      SELECT * FROM messages
      WHERE (delivered_to = ? AND state IN ('pushed', 'delivered'))
         OR (to_session = ? AND state = 'queued')
      ORDER BY seq
    `).all(session, session) as MessageRow[]).map(toMessage);
  }

  markPushed(id: string, stream: string, to: SessionAddress): void {
    this.db.query("UPDATE messages SET state = 'pushed', pushed_stream = ?, delivered_to = ? WHERE id = ? AND state = 'queued'").run(stream, to, id);
  }

  /** Confirms a push, only from the stream it was pushed on. Answers whether it matched. */
  markDelivered(id: string, stream: string, at: string): boolean {
    return this.db.query("UPDATE messages SET state = 'delivered', delivered_at = ?, pushed_stream = NULL WHERE id = ? AND state = 'pushed' AND pushed_stream = ?").run(at, id, stream).changes === 1;
  }

  /** A stream closed: whatever it had not confirmed goes back to the queue. */
  requeueStream(stream: string): number {
    return this.db.query("UPDATE messages SET state = 'queued', pushed_stream = NULL, delivered_to = NULL WHERE state = 'pushed' AND pushed_stream = ?").run(stream).changes;
  }

  markAnswered(id: string, replyId: string): void {
    this.db.query("UPDATE messages SET state = 'answered', answered_by = ? WHERE id = ? AND state IN ('delivered', 'pushed', 'queued')").run(replyId, id);
  }

  cancel(id: string): boolean {
    return this.db.query("UPDATE messages SET state = 'cancelled' WHERE id = ? AND state = 'queued'").run(id).changes === 1;
  }

  expire(now: string): number {
    return this.db.query("UPDATE messages SET state = 'expired' WHERE state = 'queued' AND expires_at < ?").run(now).changes;
  }

  // Sessions

  upsertSession(s: SessionRow): void {
    this.db.query(`
      INSERT INTO sessions (address, machine, cwd, title, channel, connected, last_seen)
      VALUES ($address, $machine, $cwd, $title, $channel, $connected, $lastSeen)
      ON CONFLICT (address) DO UPDATE SET machine = $machine, cwd = $cwd, title = $title, channel = $channel, connected = $connected, last_seen = $lastSeen
    `).run({ ...s, channel: s.channel ? 1 : 0, connected: s.connected ? 1 : 0 });
  }

  setConnected(address: SessionAddress, connected: boolean, at: string): void {
    this.db.query("UPDATE sessions SET connected = ?, last_seen = ? WHERE address = ?").run(connected ? 1 : 0, at, address);
  }

  getSession(address: SessionAddress): SessionRow | undefined {
    const row = this.db.query("SELECT * FROM sessions WHERE address = ?").get(address) as Record<string, unknown> | null;
    return row ? sessionRow(row) : undefined;
  }

  sessions(): SessionRow[] {
    return (this.db.query("SELECT * FROM sessions ORDER BY last_seen DESC").all() as Record<string, unknown>[]).map(sessionRow);
  }

  /** At boot nothing is connected: streams do not survive a restart. */
  disconnectAll(): void {
    this.db.exec("UPDATE sessions SET connected = 0");
    this.db.exec("UPDATE messages SET state = 'queued', pushed_stream = NULL, delivered_to = NULL WHERE state = 'pushed'");
  }

  // Bots

  replaceBots(machine: string, bots: PublishedBot[], at: string): void {
    this.transaction(() => {
      this.db.query("DELETE FROM bots WHERE machine = ?").run(machine);
      const insert = this.db.query("INSERT INTO bots (machine, bot_id, name, path, session_ids_json, published_at) VALUES (?, ?, ?, ?, ?, ?)");
      for (const bot of bots) insert.run(machine, bot.botId, bot.name, bot.path, JSON.stringify(bot.sessionIds), at);
    });
  }

  bots(): BotRow[] {
    return (this.db.query("SELECT * FROM bots ORDER BY name").all() as Record<string, unknown>[]).map((row) => ({
      machine: row.machine as string,
      botId: row.bot_id as string,
      name: row.name as string,
      path: row.path as string,
      sessionIds: JSON.parse(row.session_ids_json as string) as string[],
      publishedAt: row.published_at as string,
    }));
  }
}

function sessionRow(row: Record<string, unknown>): SessionRow {
  return {
    address: row.address as SessionAddress,
    machine: row.machine as string,
    cwd: row.cwd as string,
    title: row.title as string,
    channel: row.channel === 1,
    connected: row.connected === 1,
    lastSeen: row.last_seen as string,
  };
}
