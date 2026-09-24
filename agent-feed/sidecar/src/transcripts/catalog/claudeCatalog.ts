// Finding Claude's sessions on disk, and what one of them is called.
//
// Claude lays a transcript out at ~/.claude/projects/<slug>/<sessionId>.jsonl, and the
// slug is a mangled path rather than the real one, so the project a session belongs to
// is resolved by reading the file rather than by decoding the directory name.

import { existsSync } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { config } from "@/config/config";
import { claudeAdapter } from "@/transcripts/claude/claudeTranscript";
import type { Session, SourceId } from "@/transcripts/transcriptTypes";
import { state } from "@/transcripts/transcriptState";
import {
  CLAUDE_SESSION_PATTERN,
  PROMPT_TITLE_CHARACTERS,
  scheduleBroadcast,
  sessionKey,
  SUMMARY_TITLE_CHARACTERS,
} from "@/transcripts/catalog/catalogState";
import {
  canonicalDirectory,
  canonicalProjectPath,
  compactTitle,
  isClaudeSessionCandidate,
  makeSession,
} from "@/transcripts/catalog/catalogRecords";

async function enumerateClaudeCandidates(): Promise<string[]> {
  let slugNames: string[];
  try {
    slugNames = await readdir(config.claudeProjectsDirectory);
  } catch {
    return [];
  }
  const candidates: string[] = [];
  for (const slugName of slugNames) {
    const slugPath = join(config.claudeProjectsDirectory, slugName);
    let fileNames: string[];
    try {
      fileNames = await readdir(slugPath);
    } catch {
      continue;
    }
    for (const fileName of fileNames) {
      if (CLAUDE_SESSION_PATTERN.test(fileName)) {
        candidates.push(join(slugPath, fileName));
      }
    }
  }
  return candidates;
}

/**
 * Which project a Claude session belongs to, given where it opened and where its shell ended up.
 *
 * The opening directory wins, because that is the project; a later `cwd` is only ever the agent
 * having run `cd`, and honouring it filed one repo's sessions under three phantom projects named
 * after its own subfolders (`chatbot/backend`, `chatbot/frontend`, `chatbot/web`).
 *
 * The fallback is what keeps a RENAMED project findable, which is why the recent path is read at
 * all. Existence is the discriminator and it is exact: a rename leaves the opening path gone, a
 * `cd` leaves it untouched. So "the first directory, unless it is no longer there" separates the
 * two without guessing, and a session whose directory was deleted outright still resolves to
 * nothing, as before.
 */
export async function resolveClaudeProject(
  openedIn: string,
  recent: string | undefined,
): Promise<string | null> {
  const opened = await canonicalDirectory(openedIn);
  if (opened) return opened;
  if (!recent || recent === openedIn) return null;
  return canonicalDirectory(recent);
}

/**
 * Re-reads one Claude transcript into the catalog, and tells the subscribers.
 *
 * A path that is not a Claude transcript is a no-op rather than an error, because the watcher
 * hands this every file under the projects directory.
 *
 * A file that is still on disk and did not read is a failed READ, not a session that ended, so
 * the record already held stands. This fires on every write a running agent makes, and answering
 * a failed read with a delete is how a working session vanished from the panel mid-turn.
 *
 * A transcript that reads fine and names a directory that is no longer there is a different
 * answer, and it still drops: that one is news about the session rather than about the read.
 */
export async function refreshClaudeSession(filePath: string): Promise<void> {
  if (!isClaudeSessionCandidate(filePath)) return;
  const sessionId = claudeAdapter.filePathToSessionId(filePath);
  if (!sessionId) return;
  const { session, readable } = await readClaudeCandidate(filePath);
  const key = sessionKey("claude", sessionId);
  if (session) state.sessions.set(key, session);
  else if (readable || !existsSync(filePath)) state.sessions.delete(key);
  else {
    // Said out loud rather than swallowed: a transcript this reader cannot make a session out of
    // is the shape of bug that otherwise only shows as a row that never updates.
    console.log(JSON.stringify({
      event: "agent-feed-catalog-unreadable",
      source: "claude",
      sessionId,
      held: state.sessions.has(key),
    }));
    return;
  }
  scheduleBroadcast();
}

/**
 * One candidate read into a record, and, when there is none, whether the FILE was the problem.
 *
 * The two nulls are different news and the callers act on them differently. `readable` false is
 * this reader failing on a file that is there -- a header it could make nothing of, a stat that
 * threw -- and says nothing about the session. `readable` true with no session is the file
 * answering plainly that the directory it names is gone.
 */
interface ClaudeCandidate {
  session: Session | null;
  readable: boolean;
}

async function readClaudeCandidate(filePath: string): Promise<ClaudeCandidate> {
  const sessionId = claudeAdapter.filePathToSessionId(filePath);
  if (!sessionId || !isClaudeSessionCandidate(filePath)) return { session: null, readable: true };
  const header = await claudeAdapter.readHeader(filePath);
  if (!header?.cwd) return { session: null, readable: false };
  const project = await resolveClaudeProject(header.cwd, header.recentCwd);
  if (!project) return { session: null, readable: true };
  let metadata: Awaited<ReturnType<typeof stat>>;
  try {
    metadata = await stat(filePath);
  } catch {
    return { session: null, readable: false };
  }
  const session = makeSession("claude", sessionId, project, filePath, metadata.mtimeMs, {
    title: header.title,
    gitBranch: header.gitBranch,
    entrypoint: header.entrypoint,
    lastTurnClosed: header.lastTurnClosed,
    firstPrompt: header.firstPrompt,
  });
  return { session, readable: true };
}

export async function reconcileClaude(): Promise<void> {
  const startedAt = performance.now();
  const candidates = await enumerateClaudeCandidates();
  const scanned = await Promise.all(candidates.map(async (path) => ({
    path,
    ...await readClaudeCandidate(path),
  })));
  const next = new Map(
    scanned.flatMap((read) =>
      read.session ? [[sessionKey("claude", read.session.sessionId), read.session] as const] : []
    ),
  );
  // A candidate this reader could not make a session of keeps whatever record it already had,
  // the same stickiness `refreshClaudeSession` has and for the same reason -- without it the
  // next sweep would undo the one before it.
  const unreadable = new Set(
    scanned
      .filter((read) => read.session === null && !read.readable)
      .map((read) => claudeAdapter.filePathToSessionId(read.path))
      .filter((sessionId): sessionId is string => sessionId !== null)
      .map((sessionId) => sessionKey("claude", sessionId)),
  );
  for (const [key, session] of [...state.sessions]) {
    if (session.source === "claude" && !next.has(key) && !unreadable.has(key)) {
      state.sessions.delete(key);
    }
  }
  for (const [key, session] of next) state.sessions.set(key, session);
  console.log(JSON.stringify({
    event: "agent-feed-catalog-source-ready",
    source: "claude",
    durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
    candidates: candidates.length,
    sessions: next.size,
    unreadable: unreadable.size,
  }));
}
