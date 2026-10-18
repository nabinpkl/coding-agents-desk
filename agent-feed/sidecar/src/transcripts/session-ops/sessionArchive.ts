// Which sessions, and which project folders, the reader has archived on this machine.
//
// Archiving is a filing decision of ours and nothing more: the transcript is untouched, the
// provider is not told, and every surface hides the session until the reader unarchives it. A
// session that is written to again stays archived; only Unarchive brings it back.
//
// An archived project is the same decision made for a whole folder: the project leaves the list,
// and every session in it reads as archived. Its sessions keep their own entries, so unarchiving
// the folder brings back exactly the sessions that were showing before it was archived.
//
// Except a session written to since the folder was archived. Archiving a folder is refused while
// anything in it runs, so a session with newer writes is work started or resumed there afterwards,
// and hiding it would hide work in progress. It shows again, and its folder comes back to the list
// holding it, until the reader archives the folder again, which moves the folder's time forward.
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

const SESSION_ARCHIVE_VERSION = 2;
const SOURCES: readonly SourceId[] = ["claude", "codex", "pi", "opencode"];

export interface ArchivedSession extends BotSessionRef {
  /** `Date.now()` when it was archived. */
  archivedAt: number;
}

export interface ArchivedProject {
  projectPath: string;
  /** `Date.now()` when it was archived. */
  archivedAt: number;
}

interface StoredSessionArchive {
  version: 2;
  sessions: ArchivedSession[];
  projects: ArchivedProject[];
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

function isArchivedProject(value: unknown): value is ArchivedProject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.projectPath === "string"
    && entry.projectPath.length > 0
    && typeof entry.archivedAt === "number"
    && Number.isFinite(entry.archivedAt);
}

function validateArchive(value: unknown, path: string): StoredSessionArchive {
  const stored = value as { version?: unknown; sessions?: unknown; projects?: unknown } | null;
  if (
    !stored
    || stored.version !== SESSION_ARCHIVE_VERSION
    || !Array.isArray(stored.sessions)
    || !Array.isArray(stored.projects)
  ) {
    throw new Error(
      `session-archive.json at ${path} must have version ${SESSION_ARCHIVE_VERSION}, a sessions list and a projects list`,
    );
  }
  if (!stored.sessions.every(isArchivedSession) || !stored.projects.every(isArchivedProject)) {
    throw new Error(`session-archive.json at ${path} contains an invalid entry`);
  }
  return { version: SESSION_ARCHIVE_VERSION, sessions: stored.sessions, projects: stored.projects };
}

const EMPTY_ARCHIVE: StoredSessionArchive = { version: SESSION_ARCHIVE_VERSION, sessions: [], projects: [] };

export class SessionArchiveStore {
  private entries = new Map<string, ArchivedSession>();
  private projects = new Map<string, ArchivedProject>();
  private readonly loaded: Promise<void>;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {
    this.loaded = this.readFile().then((archive) => this.adopt(archive));
  }

  /** Resolves once the file has been read, so a caller that must not miss an entry can wait. */
  ready(): Promise<void> {
    return this.loaded;
  }

  /** When the session itself was archived, or undefined when it is not. Synchronous: read per row. */
  archivedAt(source: string, sessionId: string): number | undefined {
    return this.entries.get(archiveKey(source, sessionId))?.archivedAt;
  }

  /** When the project folder was archived, or undefined when it is not. */
  projectArchivedAt(projectPath: string): number | undefined {
    return this.projects.get(projectPath)?.archivedAt;
  }

  /** Archives a session, keeping the first timestamp when it already was. */
  async archive(ref: BotSessionRef, now = Date.now()): Promise<number> {
    await this.archiveMany([ref], now);
    return this.archivedAt(ref.source, ref.sessionId) ?? now;
  }

  /** Archives every session named, in one write. Answers how many were not archived already. */
  archiveMany(refs: readonly BotSessionRef[], now = Date.now()): Promise<number> {
    return this.mutate((archive) => {
      const known = new Set(archive.sessions.map((entry) => archiveKey(entry.source, entry.sessionId)));
      const added: ArchivedSession[] = [];
      for (const ref of refs) {
        const key = archiveKey(ref.source, ref.sessionId);
        if (known.has(key)) continue;
        known.add(key);
        added.push({ source: ref.source, sessionId: ref.sessionId, archivedAt: now });
      }
      if (added.length === 0) return { archive, value: 0 };
      return { archive: { ...archive, sessions: [...archive.sessions, ...added] }, value: added.length };
    });
  }

  /** Unarchives a session. True when it was archived. */
  unarchive(ref: BotSessionRef): Promise<boolean> {
    return this.mutate((archive) => {
      const key = archiveKey(ref.source, ref.sessionId);
      const kept = archive.sessions.filter((entry) => archiveKey(entry.source, entry.sessionId) !== key);
      return kept.length === archive.sessions.length
        ? { archive, value: false }
        : { archive: { ...archive, sessions: kept }, value: true };
    });
  }

  /**
   * Archives a project folder. Archiving it again moves its time forward, which is how a session
   * written there since the last time is filed away with the rest.
   */
  archiveProject(projectPath: string, now = Date.now()): Promise<number> {
    return this.mutate((archive) => {
      const kept = archive.projects.filter((entry) => entry.projectPath !== projectPath);
      return { archive: { ...archive, projects: [...kept, { projectPath, archivedAt: now }] }, value: now };
    });
  }

  /** Unarchives a project folder. True when it was archived. */
  unarchiveProject(projectPath: string): Promise<boolean> {
    return this.mutate((archive) => {
      const kept = archive.projects.filter((entry) => entry.projectPath !== projectPath);
      return kept.length === archive.projects.length
        ? { archive, value: false }
        : { archive: { ...archive, projects: kept }, value: true };
    });
  }

  private mutate<T>(
    change: (archive: StoredSessionArchive) => { archive: StoredSessionArchive; value: T },
  ): Promise<T> {
    const run = this.mutationTail.then(async () => {
      await this.loaded.catch(() => {});
      const release = await acquireFileLock(this.path);
      try {
        const latest = await this.readFile();
        const result = change(latest);
        if (result.archive !== latest) await writeJsonAtomically(this.path, result.archive);
        this.adopt(result.archive);
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
    this.projects = new Map(archive.projects.map((entry) => [entry.projectPath, entry]));
  }

  private async readFile(): Promise<StoredSessionArchive> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return EMPTY_ARCHIVE;
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

/**
 * When a session reads as archived: its own entry, or else its project folder's, unless it has
 * been written to since the folder was archived (the header says why).
 */
export function sessionArchivedAt(
  session: { source: string; sessionId: string; project: string; lastEventAt: number },
): number | undefined {
  const own = installed?.archivedAt(session.source, session.sessionId);
  if (own !== undefined) return own;
  const folder = installed?.projectArchivedAt(session.project);
  return folder !== undefined && session.lastEventAt <= folder ? folder : undefined;
}

export function projectArchivedAt(projectPath: string): number | undefined {
  return installed?.projectArchivedAt(projectPath);
}
