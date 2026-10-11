// Which sessions the reader has archived on this machine.
//
// Archiving is a filing decision of ours and nothing more: the transcript is untouched, the
// provider is not told, and every surface hides the session until the reader unarchives it. A
// session that is written to again stays archived; only Unarchive brings it back.
//
// The file is the authority, and it lives beside `bots.json` (`config.sessionArchivePath`). This
// process keeps a copy in memory so a row can be summarized without a read, re-reads the file
// under the lock before every change so a second sidecar's archive is kept rather than
// overwritten, and does NOT watch it: a change made by another process shows here on this
// process's next change or restart. That trade is deliberate. The file changes a few times a day,
// and the directory it shares with `bots.json` is one the Bot store watches and unwatches, which
// under Bun is the pattern that leaves the next watch on a path dead.

import { readFile } from "node:fs/promises";
import type { BotSessionRef, SourceId } from "@agentdesk/agent-feed-wire";
import { acquireFileLock, writeJsonAtomically } from "@/config/lockedJsonFile";

const SESSION_ARCHIVE_VERSION = 1;
const SOURCES: readonly SourceId[] = ["claude", "codex", "pi", "opencode"];

export interface ArchivedSession extends BotSessionRef {
  /** `Date.now()` when it was archived. */
  archivedAt: number;
}

interface StoredSessionArchive {
  version: 1;
  sessions: ArchivedSession[];
}

function archiveKey(source: string, sessionId: string): string {
  return `${source}:${sessionId.toLowerCase()}`;
}

function isArchivedSession(value: unknown): value is ArchivedSession {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return SOURCES.includes(entry.source as SourceId)
    && typeof entry.sessionId === "string"
    && entry.sessionId.length > 0
    && typeof entry.archivedAt === "number"
    && Number.isFinite(entry.archivedAt);
}

function validateArchive(value: unknown, path: string): StoredSessionArchive {
  const stored = value as { version?: unknown; sessions?: unknown } | null;
  if (!stored || stored.version !== SESSION_ARCHIVE_VERSION || !Array.isArray(stored.sessions)) {
    throw new Error(`session-archive.json at ${path} must have version ${SESSION_ARCHIVE_VERSION} and a sessions list`);
  }
  if (!stored.sessions.every(isArchivedSession)) {
    throw new Error(`session-archive.json at ${path} contains an invalid entry`);
  }
  return { version: SESSION_ARCHIVE_VERSION, sessions: stored.sessions };
}

export class SessionArchiveStore {
  private entries = new Map<string, ArchivedSession>();
  private readonly loaded: Promise<void>;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {
    this.loaded = this.readFile().then((archive) => this.adopt(archive));
  }

  /** Resolves once the file has been read, so a caller that must not miss an entry can wait. */
  ready(): Promise<void> {
    return this.loaded;
  }

  /** When the session was archived, or undefined when it is not. Synchronous: read per row. */
  archivedAt(source: string, sessionId: string): number | undefined {
    return this.entries.get(archiveKey(source, sessionId))?.archivedAt;
  }

  /** Archives a session, keeping the first timestamp when it already was. */
  archive(ref: BotSessionRef, now = Date.now()): Promise<number> {
    return this.mutate((sessions) => {
      const existing = sessions.find((entry) => archiveKey(entry.source, entry.sessionId) === archiveKey(ref.source, ref.sessionId));
      if (existing) return { sessions, value: existing.archivedAt };
      return {
        sessions: [...sessions, { source: ref.source, sessionId: ref.sessionId, archivedAt: now }],
        value: now,
      };
    });
  }

  /** Unarchives a session. True when it was archived. */
  unarchive(ref: BotSessionRef): Promise<boolean> {
    return this.mutate((sessions) => {
      const key = archiveKey(ref.source, ref.sessionId);
      const kept = sessions.filter((entry) => archiveKey(entry.source, entry.sessionId) !== key);
      return kept.length === sessions.length ? { sessions, value: false } : { sessions: kept, value: true };
    });
  }

  private mutate<T>(change: (sessions: ArchivedSession[]) => { sessions: ArchivedSession[]; value: T }): Promise<T> {
    const run = this.mutationTail.then(async () => {
      await this.loaded.catch(() => {});
      const release = await acquireFileLock(this.path);
      try {
        const latest = await this.readFile();
        const result = change(latest.sessions);
        if (result.sessions !== latest.sessions) {
          await writeJsonAtomically(this.path, { version: SESSION_ARCHIVE_VERSION, sessions: result.sessions });
        }
        this.adopt({ version: SESSION_ARCHIVE_VERSION, sessions: result.sessions });
        return result.value;
      } finally {
        await release();
      }
    });
    this.mutationTail = run.then(() => {}, () => {});
    return run;
  }

  private adopt(archive: StoredSessionArchive): void {
    this.entries = new Map(archive.sessions.map((entry) => [archiveKey(entry.source, entry.sessionId), entry]));
  }

  private async readFile(): Promise<StoredSessionArchive> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { version: SESSION_ARCHIVE_VERSION, sessions: [] };
      }
      throw new Error(`failed to read session-archive.json at ${this.path}`, { cause: error });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new Error(`session-archive.json at ${this.path} is not valid JSON`, { cause: error });
    }
    return validateArchive(parsed, this.path);
  }
}

/**
 * The archive the catalog consults when it summarizes a row.
 *
 * Module state, like the catalog itself: `summarizeSession` is called from a dozen places that
 * each pass only a descriptor resolver, and threading a second lookup through every one of them
 * would be churn for a fact that has exactly one answer per process. Unset in tests that do not
 * install one, which reads as "nothing is archived".
 */
let installed: SessionArchiveStore | null = null;

export function installSessionArchive(store: SessionArchiveStore | null): void {
  installed = store;
}

export function sessionArchivedAt(source: string, sessionId: string): number | undefined {
  return installed?.archivedAt(source, sessionId);
}
