import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { MIGRATIONS } from "../src/store/migrations.ts";
import { openSqliteStore } from "../src/store/sqlite-store.ts";

function inspect(file: string, sql: string): unknown {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return Object.values(db.prepare(sql).get() ?? {})[0];
  } finally {
    db.close();
  }
}

function tmpDb(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "annotator-store-")), "annotator.db");
}

const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-01-01T00:00:01.000Z";

function sample(url = "https://a.example/form") {
  return { url, title: "Form", text: "Pad the button", tag: "bug" as const, metadata: { selector: "form > button", tagName: "BUTTON" } };
}

test("migrates an empty database in WAL mode", () => {
  const file = tmpDb();
  const store = openSqliteStore(file);
  store.close();
  assert.equal(inspect(file, "PRAGMA journal_mode"), "wal");
  assert.ok(Number(inspect(file, "PRAGMA user_version")) >= 1);
  // Reopening an already migrated file is a no-op.
  const again = openSqliteStore(file);
  assert.equal(again.list({}).length, 0);
  again.close();
});

test("insert, get, list with url substring and status filters", () => {
  const store = openSqliteStore(tmpDb());
  const a = store.insert(sample(), T0);
  store.insert({ ...sample("https://b.example/"), text: "Space the hero", tag: "suggestion" }, T1);
  assert.equal(a.id, 1);
  assert.equal(a.status, "open");
  assert.deepEqual(a.metadata, { selector: "form > button", tagName: "BUTTON" });
  assert.equal(a.screenshot, null);
  assert.deepEqual(a.replies, []);
  assert.equal(store.get(1)?.text, "Pad the button");
  assert.equal(store.get(999), undefined);
  assert.equal(store.list({}).length, 2);
  assert.equal(store.list({ url: "a.example" }).length, 1);
  assert.equal(store.list({ status: "resolved" }).length, 0);
  // Most recently updated first.
  assert.deepEqual(store.list({}).map((r) => r.id), [2, 1]);
  store.close();
});

test("ids are never reused after delete", () => {
  const store = openSqliteStore(tmpDb());
  store.insert(sample(), T0);
  const two = store.insert(sample(), T0);
  assert.equal(store.remove(two.id), true);
  assert.equal(store.insert(sample(), T0).id, 3);
  assert.equal(store.remove(999), false);
  store.close();
});

test("status updates, replies, and cascade delete of replies and screenshot", () => {
  const file = tmpDb();
  const store = openSqliteStore(file);
  const a = store.insert(sample(), T0);
  assert.equal(store.setStatus(a.id, { status: "resolved", resolvedAt: T1, resolvedBy: "agent", reopenedBy: null, updatedAt: T1 }), true);
  assert.equal(store.get(a.id)?.resolvedBy, "agent");
  assert.equal(store.addReply(a.id, { by: "agent", text: "Fixed", at: T1 }), true);
  assert.equal(store.addReply(999, { by: "agent", text: "x", at: T1 }), false);
  assert.deepEqual(store.get(a.id)?.replies, [{ by: "agent", text: "Fixed", at: T1 }]);
  const bytes = new Uint8Array([1, 2, 3, 255]);
  assert.equal(store.putScreenshot(a.id, { mime: "image/jpeg", bytes, coverage: { scanned: 3, items: [{ selector: "div", tag: "DIV", text: "hi" }] } }, T1), true);
  assert.deepEqual(store.get(a.id)?.screenshot, { mime: "image/jpeg", createdAt: T1, coverageCount: 1 });
  const shot = store.getScreenshot(a.id);
  assert.deepEqual(Array.from(shot?.bytes ?? []), [1, 2, 3, 255]);
  assert.equal(shot?.coverage.scanned, 3);
  // Replacing a screenshot overwrites it.
  store.putScreenshot(a.id, { mime: "image/png", bytes: new Uint8Array([9]), coverage: { scanned: 0, items: [] } }, T1);
  assert.equal(store.getScreenshot(a.id)?.mime, "image/png");
  assert.equal(store.remove(a.id), true);
  store.close();
  assert.equal(inspect(file, "SELECT count(*) FROM replies"), 0);
  assert.equal(inspect(file, "SELECT count(*) FROM screenshots"), 0);
});

test("removeByUrl deletes the same set a url-filtered list shows", () => {
  const store = openSqliteStore(tmpDb());
  store.insert(sample("https://b.example/page"), T0);
  store.insert(sample("https://b.example/page?x=1"), T0);
  store.insert(sample("https://c.example/"), T0);
  assert.equal(store.removeByUrl("https://b.example/page"), 2);
  assert.equal(store.list({}).length, 1);
  store.close();
});

test("transaction rolls back on throw", () => {
  const store = openSqliteStore(tmpDb());
  const a = store.insert(sample(), T0);
  assert.throws(() =>
    store.transaction(() => {
      store.addReply(a.id, { by: "user", text: "kept?", at: T1 });
      throw new Error("boom");
    }),
  );
  assert.deepEqual(store.get(a.id)?.replies, []);
  store.close();
});

test("the tag migration keeps rows, replies, screenshots, and the id high-water mark", () => {
  const file = tmpDb();
  // A version-1 database as it exists in production: two rows, the newer one deleted.
  const v1 = new DatabaseSync(file);
  v1.exec("PRAGMA foreign_keys = ON");
  v1.exec(MIGRATIONS[0]!);
  v1.exec("PRAGMA user_version = 1");
  const row = `(status, url, title, text, tag, metadata_json, created_at, updated_at) VALUES ('open', 'https://a.example/', 'A', 'kept', 'question', '{}', '${T0}', '${T0}')`;
  v1.exec(`INSERT INTO annotations ${row}`);
  v1.exec(`INSERT INTO annotations ${row}`);
  v1.exec("DELETE FROM annotations WHERE id = 2");
  v1.exec(`INSERT INTO replies (annotation_id, by, text, at) VALUES (1, 'agent', 'hi', '${T0}')`);
  v1.exec(`INSERT INTO screenshots (annotation_id, mime, bytes, coverage_json, created_at) VALUES (1, 'image/jpeg', x'ffd8', '{"scanned":0,"items":[]}', '${T0}')`);
  v1.close();

  const store = openSqliteStore(file);
  const kept = store.get(1);
  assert.equal(kept?.tag, "question");
  assert.deepEqual(kept?.replies.map((r) => r.text), ["hi"]);
  assert.equal(kept?.screenshot?.mime, "image/jpeg");
  const info = store.insert({ ...sample(), tag: "info" }, T1);
  assert.equal(info.id, 3, "id 2 was deleted before the migration and must not be reused");
  assert.equal(store.insert({ ...sample(), tag: "change" }, T1).tag, "change");
  assert.throws(() => store.insert({ ...sample(), tag: "nope" as "bug" }, T1));
  // Foreign keys are back on: deleting the parent still cascades.
  assert.equal(store.remove(1), true);
  store.close();
  assert.equal(inspect(file, "SELECT count(*) FROM replies"), 0);
  assert.equal(inspect(file, "SELECT count(*) FROM screenshots"), 0);
  assert.equal(inspect(file, "PRAGMA user_version"), MIGRATIONS.length);
});
