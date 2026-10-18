import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, unlinkSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { reconcileSource, readCodexThreadRows } from "@/transcripts/catalog/transcriptCatalog";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/**
 * Writes a WAL-mode state database shaped like Codex's, then leaves it the way
 * Codex leaves it when it exits: everything checkpointed into the main file and
 * the -wal/-shm sidecars gone.
 */
async function makeCodexStateDatabase({ leaveRunning }: { leaveRunning: boolean }): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codex-state-"));
  temporaryDirectories.push(root);
  const path = join(root, "state_5.sqlite");
  const seed = new Database(path, { create: true });
  seed.run("PRAGMA journal_mode = WAL");
  seed.run(`
    CREATE TABLE threads (
      id TEXT, cwd TEXT, title TEXT, rollout_path TEXT,
      created_at_ms INTEGER, updated_at_ms INTEGER,
      created_at INTEGER, updated_at INTEGER,
      git_sha TEXT, git_branch TEXT, git_origin_url TEXT,
      archived INTEGER
    )
  `);
  seed.run(`
    INSERT INTO threads VALUES
      ('t1', '/work/one', 'first', '/rollouts/t1.jsonl', 1000, 2000, 1, 2, null, 'main', null, 0),
      ('t2', '/work/two', 'archived', '/rollouts/t2.jsonl', 1000, 3000, 1, 3, null, null, null, 1)
  `);
  seed.run("PRAGMA wal_checkpoint(TRUNCATE)");
  seed.close();
  if (!leaveRunning) {
    for (const suffix of ["-wal", "-shm"]) {
      if (existsSync(path + suffix)) unlinkSync(path + suffix);
    }
  }
  return path;
}

describe("codex state database", () => {
  // The regression: Codex keeps this database in WAL mode, and a WAL database
  // needs a -shm file that a read-only SQLite connection may not create. Codex
  // deletes it on a clean exit, so reading read-only raised SQLITE_CANTOPEN
  // whenever Codex was not running, which killed the whole sidecar on startup.
  test("reads threads when Codex is not running and left no -shm behind", async () => {
    const path = await makeCodexStateDatabase({ leaveRunning: false });
    expect(existsSync(`${path}-shm`)).toBe(false);

    const rows = readCodexThreadRows(path);

    expect(rows.map((row) => row.id)).toEqual(["t1"]);
    expect(rows[0]?.cwd).toBe("/work/one");
  });

  test("reads threads while Codex is running and holding the WAL open", async () => {
    const path = await makeCodexStateDatabase({ leaveRunning: true });

    const rows = readCodexThreadRows(path);

    expect(rows.map((row) => row.id)).toEqual(["t1"]);
  });

  // Read-write is only there so SQLite can create the -shm. The connection must
  // still refuse to modify somebody else's data.
  test("refuses to write to the database it is only reading", async () => {
    const path = await makeCodexStateDatabase({ leaveRunning: false });
    readCodexThreadRows(path);

    const database = new Database(path, { readwrite: true });
    database.run("PRAGMA query_only = ON");
    expect(() => database.run("INSERT INTO threads (id) VALUES ('t3')")).toThrow();
    database.close();

    expect(readCodexThreadRows(path).map((row) => row.id)).toEqual(["t1"]);
  });

  // Startup treats a rejected reconcile as fatal and exits, so before this an
  // unreadable Codex database killed the healthy Claude source too, and every
  // restart hit the same file: 41 restarts in one evening with no feed at all.
  test("one unreadable source does not take the catalog down with it", async () => {
    let healthySourceRan = false;

    await expect(
      Promise.all([
        reconcileSource("codex", () => Promise.reject(new Error("SQLITE_CANTOPEN"))),
        reconcileSource("claude", async () => {
          healthySourceRan = true;
        }),
      ]),
    ).resolves.toBeDefined();

    expect(healthySourceRan).toBe(true);
  });

  test("archived threads stay out of the list", async () => {
    const path = await makeCodexStateDatabase({ leaveRunning: false });

    const rows = readCodexThreadRows(path);

    expect(rows.some((row) => row.id === "t2")).toBe(false);
  });
});
