// Durable arena state: one `runs.json` index plus one diff file per closed contestant.
//
// The index carries every field except `gitDiff`, because a diff scales with the work its prompt
// asked for and would make the index unbounded; each closed contestant's diff lands beside its
// run as `<root>/<runId>/<contestantId>.diff`, read back only by the detail route. The write is
// temp-then-rename, the same discipline the sidecar board's own descriptors keep: a reader that
// arrives mid-write sees the last whole index, never half of the next one.

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { ArenaContestantRecord, ArenaRunRecord } from "@/arena/arenaRun";

/** One arena record too many on disk is a broken store, not a quiet truncation. */
export class ArenaStoreError extends Error {}

/**
 * The record as it is persisted: the in-memory shape with the diff stripped.
 *
 * Narrowed with `Omit` rather than copied field-for-field so a field added to the record is
 * persisted by default, and only a field that must not be (the diff, again) has to be named here.
 */
export type StoredArenaRunRecord = Omit<ArenaRunRecord, "contestants"> & {
  contestants: Omit<ArenaContestantRecord, "gitDiff">[];
};

/** The diff is dropped on the way to disk and read back on the way out, so it never rides the index. */
function toStored(run: ArenaRunRecord): StoredArenaRunRecord {
  return {
    ...run,
    contestants: run.contestants.map(({ gitDiff: _gitDiff, ...contestant }) => contestant),
  };
}

function parseRun(value: unknown, at: number): ArenaRunRecord {
  if (!value || typeof value !== "object") throw new ArenaStoreError(`runs.json entry ${at} is not an object`);
  const record = value as Record<string, unknown>;
  const runId = typeof record.runId === "string" ? record.runId : null;
  const prompt = typeof record.prompt === "string" ? record.prompt : null;
  const repoPath = typeof record.repoPath === "string" ? record.repoPath : null;
  const baseRef = typeof record.baseRef === "string" ? record.baseRef : null;
  const createdAt = typeof record.createdAt === "number" ? record.createdAt : null;
  if (!runId || !prompt || !repoPath || !baseRef || createdAt === null) {
    throw new ArenaStoreError(`runs.json entry ${at} is missing a field the arena cannot invent`);
  }
  if (!Array.isArray(record.contestants)) {
    throw new ArenaStoreError(`runs.json entry ${at} has no contestants`);
  }
  const contestants: ArenaContestantRecord[] = record.contestants.map((raw, index) => {
    if (!raw || typeof raw !== "object") {
      throw new ArenaStoreError(`runs.json entry ${at} contestant ${index} is not an object`);
    }
    const c = raw as Record<string, unknown>;
    const contestantId = typeof c.contestantId === "string" ? c.contestantId : null;
    const worktreePath = typeof c.worktreePath === "string" ? c.worktreePath : null;
    const source = c.source === "opencode" ? "opencode" : null;
    if (!contestantId || !worktreePath || !source) {
      throw new ArenaStoreError(`runs.json entry ${at} contestant ${index} is missing its identity`);
    }
    return {
      contestantId,
      source,
      sessionId: typeof c.sessionId === "string" ? c.sessionId : null,
      worktreePath,
      status: isContestantStatus(c.status) ? c.status : "failed",
      startedAt: typeof c.startedAt === "number" ? c.startedAt : null,
      closedAt: typeof c.closedAt === "number" ? c.closedAt : null,
      error: typeof c.error === "string" ? c.error : null,
      contextTokens: typeof c.contextTokens === "number" ? c.contextTokens : null,
      costUsd: typeof c.costUsd === "number" ? c.costUsd : null,
      filesRead: stringArray(c.filesRead),
      filesWritten: stringArray(c.filesWritten),
      gitDiff: null,
    };
  });
  return { runId, prompt, repoPath, baseRef, createdAt, contestants };
}

function isContestantStatus(value: unknown): value is ArenaContestantRecord["status"] {
  return value === "preparing" || value === "running" || value === "closed" || value === "failed";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? [...value] : [];
}

/** Durable arena state under one root, created on first write. */
export class ArenaStore {
  private readonly root: string;

  constructor(root: string) {
    if (!isAbsolute(root)) throw new ArenaStoreError(`arena root must be absolute: "${root}"`);
    this.root = root;
  }

  /** Every run on disk, or none when the arena has never written. A malformed store throws. */
  load(): ArenaRunRecord[] {
    const index = join(this.root, "runs.json");
    if (!existsSync(index)) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(index, "utf8"));
    } catch (error) {
      throw new ArenaStoreError(`arena runs.json is not JSON: ${String(error)}`);
    }
    if (!Array.isArray(parsed)) throw new ArenaStoreError("arena runs.json is not an array");
    return parsed.map((entry, at) => parseRun(entry, at));
  }

  /** Writes the whole index atomically. Diffs are dropped; they have files of their own. */
  save(runs: ArenaRunRecord[]): void {
    mkdirSync(this.root, { recursive: true });
    const index = join(this.root, "runs.json");
    const temporary = `${index}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(runs.map(toStored)));
    renameSync(temporary, index);
  }

  /** One closed contestant's diff, beside its run. */
  writeContestantDiff(runId: string, contestantId: string, diff: string): void {
    const path = this.diffPath(runId, contestantId);
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, diff);
    renameSync(temporary, path);
  }

  /** That diff back, or null when the contestant never closed or never diffed. */
  readContestantDiff(runId: string, contestantId: string): string | null {
    const path = this.diffPath(runId, contestantId);
    if (!existsSync(path)) return null;
    return readFileSync(path, "utf8");
  }

  /**
   * Deletes one run's directory under the arena root: `<root>/<runId>` and nothing else.
   *
   * The runId is checked against the run-directory shape and the joined path against the root,
   * the same confinement the browse paths keep: a malformed id from a request must fail as a bad
   * request, never arrive at a delete of a directory the arena did not make.
   */
  deleteRunDirectory(runId: string): void {
    if (!/^[0-9a-f-]{36}$/.test(runId)) {
      throw new ArenaStoreError(`"${runId}" is not a run id`);
    }
    const path = join(this.root, runId);
    if (!path.startsWith(`${this.root}/`)) {
      throw new ArenaStoreError(`${path} is not under the arena root`);
    }
    rmSync(path, { recursive: true, force: true });
  }

  private diffPath(runId: string, contestantId: string): string {
    return join(this.root, runId, `${contestantId}.diff`);
  }
}
