/* Ordered schema migrations. The index + 1 is the PRAGMA user_version it
 * produces. Append only: never edit a migration that has shipped. */
export const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE annotations (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    status        TEXT NOT NULL CHECK (status IN ('open', 'resolved')),
    url           TEXT NOT NULL,
    title         TEXT NOT NULL,
    text          TEXT NOT NULL,
    tag           TEXT NOT NULL CHECK (tag IN ('bug', 'suggestion', 'question')),
    metadata_json TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    resolved_at   TEXT,
    resolved_by   TEXT CHECK (resolved_by IN ('user', 'agent')),
    reopened_by   TEXT CHECK (reopened_by IN ('user', 'agent'))
  );
  CREATE INDEX annotations_status_updated ON annotations (status, updated_at);

  CREATE TABLE replies (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    annotation_id INTEGER NOT NULL REFERENCES annotations (id) ON DELETE CASCADE,
    by            TEXT NOT NULL CHECK (by IN ('user', 'agent')),
    text          TEXT NOT NULL,
    at            TEXT NOT NULL
  );
  CREATE INDEX replies_annotation ON replies (annotation_id, id);

  CREATE TABLE screenshots (
    annotation_id INTEGER PRIMARY KEY REFERENCES annotations (id) ON DELETE CASCADE,
    mime          TEXT NOT NULL,
    bytes         BLOB NOT NULL,
    coverage_json TEXT NOT NULL,
    created_at    TEXT NOT NULL
  );
  `,
  // Tags comment, change, info. SQLite cannot alter a CHECK, so rebuild the
  // table (migrate() runs this with foreign keys off, so replies and
  // screenshots are not cascaded away) and carry the AUTOINCREMENT high-water
  // mark over so deleted ids are never reused.
  `
  CREATE TABLE annotations_next (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    status        TEXT NOT NULL CHECK (status IN ('open', 'resolved')),
    url           TEXT NOT NULL,
    title         TEXT NOT NULL,
    text          TEXT NOT NULL,
    tag           TEXT NOT NULL CHECK (tag IN ('comment', 'bug', 'change', 'suggestion', 'question', 'info')),
    metadata_json TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    resolved_at   TEXT,
    resolved_by   TEXT CHECK (resolved_by IN ('user', 'agent')),
    reopened_by   TEXT CHECK (reopened_by IN ('user', 'agent'))
  );
  INSERT INTO annotations_next (id, status, url, title, text, tag, metadata_json, created_at, updated_at, resolved_at, resolved_by, reopened_by)
    SELECT id, status, url, title, text, tag, metadata_json, created_at, updated_at, resolved_at, resolved_by, reopened_by FROM annotations;
  DELETE FROM sqlite_sequence WHERE name = 'annotations_next';
  INSERT INTO sqlite_sequence (name, seq) SELECT 'annotations_next', seq FROM sqlite_sequence WHERE name = 'annotations';
  DROP TABLE annotations;
  ALTER TABLE annotations_next RENAME TO annotations;
  CREATE INDEX annotations_status_updated ON annotations (status, updated_at);
  `,
];
