// Finding Codex's sessions, which live in a SQLite database rather than on the filesystem.
//
// The rollout files are the transcripts, but what a thread IS -- its project, its title,
// its branch -- comes from `state_<N>.sqlite`. A rollout append can therefore only change
// two things about a session, which is what `refreshCodexRollout` exists to exploit.

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { basename } from "node:path";
import { config } from "../config.ts";
import { codexAdapter, resolveStateDbPath } from "./sources/codexTranscript.ts";
import type { Session } from "./sources/transcriptTypes.ts";
import { state } from "./transcriptState.ts";
import {
  broadcast,
  CODEX_TAIL_BYTES,
  ROLLOUT_PATTERN,
  scheduleBroadcast,
  sessionKey,
  SUMMARY_TITLE_CHARACTERS,
} from "./catalogState.ts";
import { canonicalDirectory, makeSession } from "./catalogRecords.ts";

let codexReconcileTimer: ReturnType<typeof setTimeout> | null = null;
let codexReconcileSettledAt = 0;
// Full passes are chained rather than fired independently: two of them mutating
// `state.sessions` at once would interleave their deletions with each other's
// insertions.
let codexReconcilePass: Promise<void> = Promise.resolve();

interface CodexThreadRow {
  id: string;
  cwd: string;
  title: string;
  rollout_path: string;
  created_at_ms: number | null;
  updated_at_ms: number | null;
  created_at: number;
  updated_at: number;
  git_sha: string | null;
  git_branch: string | null;
  git_origin_url: string | null;
}

/**
 * Reads Codex's thread list out of its own state database.
 *
 * Opened read-write rather than read-only, which reads backwards but is not.
 * Codex keeps this database in WAL mode, and a WAL database needs a -shm file
 * that a read-only SQLite connection is not allowed to create. Codex deletes
 * that file when it exits cleanly, so a read-only open worked only while Codex
 * happened to be running and raised SQLITE_CANTOPEN the rest of the time.
 * `query_only` then makes the connection refuse writes at the SQLite level, so
 * this stays what it should be: a reader of somebody else's data.
 */
export function readCodexThreadRows(databasePath: string): CodexThreadRow[] {
  const database = new Database(databasePath, { readwrite: true });
  try {
    database.exec("PRAGMA query_only = ON");
    return database.prepare(`
      SELECT id, cwd, title, rollout_path,
             created_at_ms, updated_at_ms, created_at, updated_at,
             git_sha, git_branch, git_origin_url
      FROM threads
      WHERE archived = 0
      ORDER BY updated_at_ms DESC, id DESC
    `).all() as CodexThreadRow[];
  } finally {
    database.close();
  }
}

function readCodexRows(): CodexThreadRow[] {
  const databasePath = resolveStateDbPath();
  if (!databasePath || !existsSync(databasePath)) return [];
  return readCodexThreadRows(databasePath);
}

export async function reconcileCodex(): Promise<void> {
  const startedAt = performance.now();
  const rows = readCodexRows();
  // One resolution per DIRECTORY, not per row. 953 threads live in 113 directories
  // here, so the pass was asking the filesystem the same question eight times over.
  // Worth most where it is felt most: on the first pass of a fresh process the
  // kernel's path cache is cold and the 953 cost 188ms, against 0.8ms for the 113.
  // Once warm the same 953 cost about 9ms, so on a running sidecar this is a real
  // but small share of a 50-70ms pass -- too small to separate from run-to-run noise
  // by timing the pass, and kept because it is strictly less work rather than
  // because a measurement showed it.
  //
  // Local to the pass and thrown away with it: deduplication of one snapshot's work,
  // not a cache, so there is no lifetime to reason about and nothing to invalidate.
  // Promises are stored rather than results because these all run at once.
  const projects = new Map<string, Promise<string | null>>();
  const projectOf = (cwd: string): Promise<string | null> => {
    const known = projects.get(cwd);
    if (known) return known;
    const resolving = canonicalDirectory(cwd);
    projects.set(cwd, resolving);
    return resolving;
  };
  const resolved = await Promise.all(rows.map(async (row): Promise<Session | null> => {
    if (!row.id || !row.cwd || !row.rollout_path) return null;
    const project = await projectOf(row.cwd);
    if (!project) return null;
    // The database and the rollout file are two records of the same session and the
    // file is the one that moves first, so the catalog takes the newer. Resolved here
    // rather than by each consumer: `lastEventAt` is what everything downstream uses
    // to decide whether a session changed, and a stamp that lags the file makes that
    // question unanswerable anywhere else.
    let updatedAt = row.updated_at_ms ?? row.updated_at * 1000;
    try {
      updatedAt = Math.max(updatedAt, (await stat(row.rollout_path)).mtimeMs);
    } catch {
      // A row whose rollout file is gone keeps the database's own stamp.
    }
    // The one read in this function that touches a rollout, and the only place the
    // catalog opens a transcript that SQLite could not answer for. Restricted to the
    // live window because that is the only place the answer can change anything:
    // outside it `computeActivity` decides from age alone. A stamp that later goes
    // stale is harmless for the same reason -- age is re-checked at read time, so a
    // stale "open" cannot keep a cold session showing live.
    const lastTurnClosed = Date.now() - updatedAt < config.liveWindowMs
      ? await codexAdapter.readTail(row.rollout_path, CODEX_TAIL_BYTES)
      : undefined;
    return makeSession("codex", row.id, project, row.rollout_path, updatedAt, {
      title: row.title.trim() || undefined,
      gitBranch: row.git_branch ?? undefined,
      lastTurnClosed,
    });
  }));
  const next = new Map(
    resolved
      .filter((session): session is Session => session !== null)
      .map((session) => [sessionKey(session.source, session.sessionId), session]),
  );
  for (const [key, session] of [...state.sessions]) {
    if (session.source === "codex" && !next.has(key)) state.sessions.delete(key);
  }
  for (const [key, session] of next) state.sessions.set(key, session);
  console.log(JSON.stringify({
    event: "agent-feed-catalog-source-ready",
    source: "codex",
    durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
    rows: rows.length,
    sessions: next.size,
  }));
}

/**
 * Refreshes ONE Codex session from its own rollout file.
 *
 * A rollout append changes exactly two things about a session: when it last moved,
 * and whether its last turn is still open. Everything else on the record -- which
 * project it belongs to, its title, its branch -- comes from Codex's state database
 * and cannot change without a write there, which has a watcher of its own. So the
 * overwhelmingly common event, an agent writing a line, now costs one `stat` and at
 * most one bounded tail read.
 *
 * It used to cost a re-read of the whole catalog: 953 rows out of SQLite, then a
 * `realpath` and two `stat`s per row. Measured on this machine that was 50-200ms,
 * fired 10-30 times a minute and bursting to twice a second with several Codex
 * agents running -- the sidecar's entire idle CPU, spent re-deriving 952 records
 * that had not changed.
 *
 * Anything this cannot answer from the record it already holds falls through to the
 * full pass, which stays the authority on what the catalog CONTAINS.
 */
export async function refreshCodexRollout(filePath: string): Promise<void> {
  const sessionId = ROLLOUT_PATTERN.exec(basename(filePath))?.[1];
  if (!sessionId) return;
  const key = sessionKey("codex", sessionId);
  const known = state.sessions.get(key);
  // No record, or a record pointing somewhere else (an archived thread whose file
  // moved): both are questions about membership, which is the full pass's job.
  if (!known || known.transcriptPath !== filePath) {
    scheduleCodexReconcile();
    return;
  }

  let mtimeMs: number;
  try {
    mtimeMs = (await stat(filePath)).mtimeMs;
  } catch {
    scheduleCodexReconcile();
    return;
  }
  const lastEventAt = Math.max(known.lastEventAt, mtimeMs);
  // Same rule the full pass uses: outside the live window `computeActivity` decides
  // from age alone, so opening the transcript there would buy nothing.
  const lastTurnClosed = Date.now() - lastEventAt < config.liveWindowMs
    ? await codexAdapter.readTail(filePath, CODEX_TAIL_BYTES)
    : known.lastTurnClosed;

  // Re-read rather than writing into the record captured above: a full pass may have
  // replaced it while the tail read was in flight, and updating the old object would
  // throw away whatever that pass learned.
  const current = state.sessions.get(key);
  if (!current || current.transcriptPath !== filePath) return;
  if (current.lastEventAt === lastEventAt && current.lastTurnClosed === lastTurnClosed) return;
  current.lastEventAt = lastEventAt;
  current.lastTurnClosed = lastTurnClosed;
  scheduleBroadcast();
}

/**
 * How long the full Codex pass must wait after finishing before it may run again.
 *
 * A floor, not a delay: the first request after a quiet spell still runs within
 * `CODEX_RECONCILE_COALESCE_MS`. It exists because the trigger is a file watcher on
 * files that a running agent writes continuously, and the pass is the expensive one.
 */
const CODEX_RECONCILE_FLOOR_MS = 1000;
const CODEX_RECONCILE_COALESCE_MS = 40;

/**
 * Asks for a full Codex pass, at most one pending at a time.
 *
 * Throttle, not debounce. The old shape restarted its timer on every event, which
 * has two failure modes against a continuous writer: a burst fires the pass once per
 * gap in it, and a truly continuous stream postpones it forever. Holding the
 * already-scheduled pass instead makes the rate an upper bound rather than a
 * function of how the writes happen to land.
 */
export function scheduleCodexReconcile(): void {
  if (codexReconcileTimer) return;
  const wait = Math.max(
    CODEX_RECONCILE_COALESCE_MS,
    codexReconcileSettledAt + CODEX_RECONCILE_FLOOR_MS - Date.now(),
  );
  codexReconcileTimer = setTimeout(() => {
    codexReconcileTimer = null;
    codexReconcilePass = codexReconcilePass
      .then(() => reconcileCodex())
      .then(broadcast)
      .catch((error) => {
        console.error("agent feed Codex catalog reconcile failed", error);
      })
      .finally(() => {
        codexReconcileSettledAt = Date.now();
      });
  }, wait);
}

/**
 * Drops the pending pass and the floor. Called from `stopCatalog`.
 *
 * The floor is measured from the last pass of the run that just ended, so a fresh
 * one must not inherit it and sit out its first second.
 */
export function stopCodexReconcile(): void {
  if (codexReconcileTimer) {
    clearTimeout(codexReconcileTimer);
    codexReconcileTimer = null;
  }
  codexReconcileSettledAt = 0;
}
