/* node:sqlite implementation of AnnotationStore. One file, WAL, foreign keys
 * on, migrations tracked by PRAGMA user_version. addReply and putScreenshot
 * also bump the parent's updated_at so recency ordering stays truthful. */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { Actor, Annotation, Coverage, ElementMetadata, NewAnnotation, Reply, Status, Tag } from "../../../shared/annotation.ts";
import { MIGRATIONS } from "./migrations.ts";
import type { AnnotationStore, ListFilter, Screenshot, StatusChange } from "./store.ts";

interface AnnotationRow {
  id: number;
  status: Status;
  url: string;
  title: string;
  text: string;
  tag: Tag;
  metadata_json: string;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  resolved_by: Actor | null;
  reopened_by: Actor | null;
  shot_mime: string | null;
  shot_created_at: string | null;
  shot_coverage_count: number | null;
}

const SELECT_ANNOTATION = `
  SELECT a.*, s.mime AS shot_mime, s.created_at AS shot_created_at,
         json_array_length(s.coverage_json, '$.items') AS shot_coverage_count
  FROM annotations a LEFT JOIN screenshots s ON s.annotation_id = a.id`;

function migrate(db: DatabaseSync): void {
  const current = Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
  if (current > MIGRATIONS.length) {
    throw new Error(`database schema version ${current} is newer than this build (${MIGRATIONS.length})`);
  }
  // Foreign keys off while migrating: a table rebuild drops the old table, which would otherwise
  // cascade-delete its children. The pragma is a no-op inside a transaction, hence out here, and
  // foreign_key_check proves each migration left no dangling reference before it commits.
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    for (let v = current; v < MIGRATIONS.length; v++) {
      db.exec("BEGIN");
      try {
        db.exec(MIGRATIONS[v]!);
        const dangling = db.prepare("PRAGMA foreign_key_check").all();
        if (dangling.length > 0) throw new Error(`migration ${v + 1} left ${dangling.length} dangling foreign keys`);
        db.exec(`PRAGMA user_version = ${v + 1}`);
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    }
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

export function openSqliteStore(file: string): AnnotationStore {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  migrate(db);

  const q = {
    insert: db.prepare(`INSERT INTO annotations (status, url, title, text, tag, metadata_json, created_at, updated_at)
                        VALUES ('open', ?, ?, ?, ?, ?, ?, ?)`),
    get: db.prepare(`${SELECT_ANNOTATION} WHERE a.id = ?`),
    replies: db.prepare("SELECT annotation_id, by, text, at FROM replies WHERE annotation_id = ? ORDER BY id"),
    setStatus: db.prepare(`UPDATE annotations SET status = ?, resolved_at = ?, resolved_by = ?, reopened_by = ?, updated_at = ?
                           WHERE id = ?`),
    touch: db.prepare("UPDATE annotations SET updated_at = ? WHERE id = ?"),
    addReply: db.prepare("INSERT INTO replies (annotation_id, by, text, at) VALUES (?, ?, ?, ?)"),
    remove: db.prepare("DELETE FROM annotations WHERE id = ?"),
    removeByUrl: db.prepare("DELETE FROM annotations WHERE instr(url, ?) > 0"),
    putShot: db.prepare(`INSERT INTO screenshots (annotation_id, mime, bytes, coverage_json, created_at) VALUES (?, ?, ?, ?, ?)
                         ON CONFLICT (annotation_id) DO UPDATE SET mime = excluded.mime, bytes = excluded.bytes,
                           coverage_json = excluded.coverage_json, created_at = excluded.created_at`),
    getShot: db.prepare("SELECT mime, bytes, coverage_json, created_at FROM screenshots WHERE annotation_id = ?"),
  };

  let depth = 0;
  function transaction<T>(fn: () => T): T {
    if (depth > 0) return fn();
    db.exec("BEGIN IMMEDIATE");
    depth++;
    try {
      const out = fn();
      db.exec("COMMIT");
      return out;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    } finally {
      depth--;
    }
  }

  function repliesFor(ids: number[]): Map<number, Reply[]> {
    const out = new Map<number, Reply[]>();
    if (ids.length === 0) return out;
    const rows = db
      .prepare(`SELECT annotation_id, by, text, at FROM replies WHERE annotation_id IN (${ids.map(() => "?").join(",")}) ORDER BY id`)
      .all(...ids) as unknown as Array<{ annotation_id: number } & Reply>;
    for (const r of rows) {
      const list = out.get(r.annotation_id) ?? [];
      list.push({ by: r.by, text: r.text, at: r.at });
      out.set(r.annotation_id, list);
    }
    return out;
  }

  function toAnnotation(row: AnnotationRow, replies: Reply[]): Annotation {
    return {
      id: row.id,
      status: row.status,
      url: row.url,
      title: row.title,
      text: row.text,
      tag: row.tag,
      metadata: JSON.parse(row.metadata_json) as ElementMetadata,
      replies,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      resolvedAt: row.resolved_at,
      resolvedBy: row.resolved_by,
      reopenedBy: row.reopened_by,
      screenshot: row.shot_mime
        ? { mime: row.shot_mime, createdAt: row.shot_created_at ?? "", coverageCount: row.shot_coverage_count ?? 0 }
        : null,
    };
  }

  function get(id: number): Annotation | undefined {
    const row = q.get.get(id) as AnnotationRow | undefined;
    if (!row) return undefined;
    const replies = (q.replies.all(id) as unknown as Reply[]).map((r) => ({ by: r.by, text: r.text, at: r.at }));
    return toAnnotation(row, replies);
  }

  return {
    insert(input: NewAnnotation, now: string): Annotation {
      const res = q.insert.run(input.url, input.title, input.text, input.tag, JSON.stringify(input.metadata), now, now);
      const created = get(Number(res.lastInsertRowid));
      if (!created) throw new Error("insert did not persist");
      return created;
    },

    get,

    list(filter: ListFilter): Annotation[] {
      const where: string[] = [];
      const args: SQLInputValue[] = [];
      if (filter.url) {
        where.push("instr(a.url, ?) > 0");
        args.push(filter.url);
      }
      if (filter.status) {
        where.push("a.status = ?");
        args.push(filter.status);
      }
      const sql = `${SELECT_ANNOTATION} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY a.updated_at DESC, a.id DESC`;
      const rows = db.prepare(sql).all(...args) as unknown as AnnotationRow[];
      const replies = repliesFor(rows.map((r) => r.id));
      return rows.map((r) => toAnnotation(r, replies.get(r.id) ?? []));
    },

    setStatus(id: number, c: StatusChange): boolean {
      return Number(q.setStatus.run(c.status, c.resolvedAt, c.resolvedBy, c.reopenedBy, c.updatedAt, id).changes) === 1;
    },

    addReply(id: number, reply: Reply): boolean {
      return transaction(() => {
        if (Number(q.touch.run(reply.at, id).changes) !== 1) return false;
        q.addReply.run(id, reply.by, reply.text, reply.at);
        return true;
      });
    },

    remove(id: number): boolean {
      return Number(q.remove.run(id).changes) === 1;
    },

    removeByUrl(url: string): number {
      return Number(q.removeByUrl.run(url).changes);
    },

    putScreenshot(id: number, shot: Omit<Screenshot, "createdAt">, now: string): boolean {
      return transaction(() => {
        if (Number(q.touch.run(now, id).changes) !== 1) return false;
        q.putShot.run(id, shot.mime, shot.bytes, JSON.stringify(shot.coverage), now);
        return true;
      });
    },

    getScreenshot(id: number): Screenshot | undefined {
      const row = q.getShot.get(id) as { mime: string; bytes: Uint8Array; coverage_json: string; created_at: string } | undefined;
      if (!row) return undefined;
      return { mime: row.mime, bytes: row.bytes, coverage: JSON.parse(row.coverage_json) as Coverage, createdAt: row.created_at };
    },

    transaction,

    close(): void {
      db.close();
    },
  };
}
