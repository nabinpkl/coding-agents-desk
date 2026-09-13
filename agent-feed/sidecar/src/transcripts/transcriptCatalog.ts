import chokidar, { type FSWatcher } from "chokidar";
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { config } from "../config.ts";
import type {
  AgentSessionCapabilities,
  AgentSessionDescriptor,
} from "../agents/agentBackend.ts";
import { piLocation, scanPiSessions } from "../agents/piSessionCatalog.ts";
import {
  PI_AGENT_CAPABILITIES,
  type PiSessionLocation,
} from "../agents/piAgentBackend.ts";
import { state, type WatcherState } from "./transcriptState.ts";
import { claudeAdapter } from "./sources/claudeTranscript.ts";
import {
  codexAdapter,
  resolveStateDbPath,
} from "./sources/codexTranscript.ts";
import type { Bin, Session, SourceId } from "./sources/transcriptTypes.ts";
import type { ProjectSummary, SessionSummary } from "@agentdesk/agent-feed-wire";

// What the catalog publishes on /api/inventory and /api/sessions, declared once in
// agent-feed/wire and parsed by the Agent Panel from that same declaration.
export type { ProjectSummary, SessionSummary } from "@agentdesk/agent-feed-wire";

/**
 * The longest a title stays as written. Past this a row shows an ellipsis instead of the tail, so
 * it is also the longest a rename can usefully be: a longer one would be stored and then not said.
 */
export const SUMMARY_TITLE_CHARACTERS = 240;
/**
 * How much of an opening prompt is allowed to stand in for a title.
 *
 * Shorter than a title's own cap because it is not one: a prompt can be a wall of
 * pasted text, and a row that renders four lines of it is worse than the fallback
 * it replaced.
 */
const PROMPT_TITLE_CHARACTERS = 120;
/**
 * How far back a Codex rollout is read to learn whether its last turn is open.
 *
 * Only ever asked for inside the live window, so this is a handful of files, not
 * the project.
 */
const CODEX_TAIL_BYTES = 32 * 1024;
const CLAUDE_SESSION_PATTERN = /^[0-9a-f-]{36}\.jsonl$/i;
const ROLLOUT_PATTERN = /^rollout-[\d-]+T[\d-]+-([0-9a-f-]{36})\.jsonl$/i;
/**
 * How long a burst of transcript writes is allowed to accumulate before the catalog
 * tells anyone.
 *
 * Codex and Pi already coalesced; Claude did not, so a running agent broadcast once
 * per line written, and every subscriber recomputed its whole view each time.
 */
const BROADCAST_COALESCE_MS = 40;
let codexReconcileTimer: ReturnType<typeof setTimeout> | null = null;
let codexReconcileSettledAt = 0;
// Full passes are chained rather than fired independently: two of them mutating
// `state.sessions` at once would interleave their deletions with each other's
// insertions.
let codexReconcilePass: Promise<void> = Promise.resolve();
let piReconcileTimer: ReturnType<typeof setTimeout> | null = null;
let broadcastTimer: ReturnType<typeof setTimeout> | null = null;

const TRANSCRIPT_CAPABILITIES: AgentSessionCapabilities = {
  modes: ["raw", "nice"],
  canSend: false,
  canSteer: false,
  canAbort: false,
  canFetchRaw: true,
  canOpenTerminal: true,
  supportsExtensionUi: false,
  canStreamLive: false,
};

export type AgentSessionDescriptorResolver = (
  source: SourceId,
  sessionId: string,
) => AgentSessionDescriptor | undefined;

export function sessionKey(source: SourceId, sessionId: string): string {
  return `${source}:${sessionId}`;
}

export function getWatcherState(): WatcherState {
  return state.watcherState;
}

export function getSnapshot(): Session[] {
  return [...state.sessions.values()].sort((left, right) =>
    right.lastEventAt - left.lastEventAt
  );
}

export function findSession(source: SourceId, sessionId: string): Session | undefined {
  return state.sessions.get(sessionKey(source, sessionId));
}

export function subscribeCatalog(listener: (sessions: Session[]) => void): () => void {
  state.subscribers.add(listener);
  return () => {
    state.subscribers.delete(listener);
  };
}

/**
 * Which version of the catalog the project list was computed against.
 *
 * The project list is a fold over every session the catalog holds, so it is the one
 * projection worth remembering between changes: N subscribers watching the same
 * catalog compute it once rather than once each. A project's session list is not
 * memoized -- it is a filter and a sort over records already in memory, and a cache
 * in front of that would cost more in invalidation rules than it saves.
 */
let catalogGeneration = 0;
let projectSummariesMemo: { generation: number; value: ProjectSummary[] } | null = null;

function broadcast(): void {
  catalogGeneration += 1;
  projectSummariesMemo = null;
  const snapshot = getSnapshot();
  for (const listener of state.subscribers) {
    try {
      listener(snapshot);
    } catch (error) {
      console.error("agent feed catalog subscriber failed", error);
    }
  }
}

/**
 * Broadcasts once for a burst of changes.
 *
 * Used by the per-file paths, which fire as fast as an agent writes. The reconciles
 * have their own timers upstream of this and broadcast directly, because by the time
 * one runs the coalescing already happened.
 */
function scheduleBroadcast(): void {
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null;
    broadcast();
  }, BROADCAST_COALESCE_MS);
}

async function canonicalDirectory(path: string): Promise<string | null> {
  try {
    const resolved = await realpath(path);
    const metadata = await stat(resolved);
    return metadata.isDirectory() ? resolved : null;
  } catch {
    return null;
  }
}

export async function canonicalProjectPath(path: string): Promise<string | null> {
  if (!path.startsWith("/")) return null;
  return canonicalDirectory(path);
}

export function isClaudeSessionCandidate(
  filePath: string,
  projectsDirectory = config.claudeProjectsDirectory,
): boolean {
  if (!CLAUDE_SESSION_PATTERN.test(basename(filePath))) return false;
  const components = relative(projectsDirectory, filePath).split(/[\\/]/);
  return components.length === 2 &&
    components.every((component) => component.length > 0 && component !== "..");
}

function makeSession(
  source: SourceId,
  sessionId: string,
  project: string,
  transcriptPath: string,
  lastEventAt: number,
  metadata: {
    title?: string;
    gitBranch?: string;
    entrypoint?: string;
    lastTurnClosed?: boolean;
    firstPrompt?: string;
  } = {},
): Session {
  return {
    sessionId,
    source,
    project,
    transcriptPath,
    lastEventAt,
    ...metadata,
    // Bounded on the way IN, not just on the way out. The catalog holds one of these
    // per session -- 1290 of them on this machine -- and a prompt is arbitrary text a
    // person pasted, so the record must not be the thing that grows with it.
    title: compactTitle(metadata.title),
    firstPrompt: compactTitle(metadata.firstPrompt?.slice(0, PROMPT_TITLE_CHARACTERS)),
  };
}

function compactTitle(value: string | undefined): string | undefined {
  const normalized = value?.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  return normalized.length <= SUMMARY_TITLE_CHARACTERS
    ? normalized
    : `${normalized.slice(0, SUMMARY_TITLE_CHARACTERS - 1)}…`;
}

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
 */
export async function refreshClaudeSession(filePath: string): Promise<void> {
  if (!isClaudeSessionCandidate(filePath)) return;
  const sessionId = claudeAdapter.filePathToSessionId(filePath);
  if (!sessionId) return;
  const session = await readClaudeCandidate(filePath);
  const key = sessionKey("claude", sessionId);
  if (session) state.sessions.set(key, session);
  else state.sessions.delete(key);
  scheduleBroadcast();
}

async function readClaudeCandidate(filePath: string): Promise<Session | null> {
  const sessionId = claudeAdapter.filePathToSessionId(filePath);
  if (!sessionId || !isClaudeSessionCandidate(filePath)) return null;
  const header = await claudeAdapter.readHeader(filePath);
  if (!header?.cwd) return null;
  const project = await resolveClaudeProject(header.cwd, header.recentCwd);
  if (!project) return null;
  let metadata: Awaited<ReturnType<typeof stat>>;
  try {
    metadata = await stat(filePath);
  } catch {
    return null;
  }
  return makeSession("claude", sessionId, project, filePath, metadata.mtimeMs, {
    title: header.title,
    gitBranch: header.gitBranch,
    entrypoint: header.entrypoint,
    lastTurnClosed: header.lastTurnClosed,
    firstPrompt: header.firstPrompt,
  });
}

async function reconcileClaude(): Promise<void> {
  const startedAt = performance.now();
  const candidates = await enumerateClaudeCandidates();
  const scanned = await Promise.all(candidates.map(readClaudeCandidate));
  const next = new Map(
    scanned
      .filter((session): session is Session => session !== null)
      .map((session) => [sessionKey(session.source, session.sessionId), session]),
  );
  for (const [key, session] of [...state.sessions]) {
    if (session.source === "claude" && !next.has(key)) state.sessions.delete(key);
  }
  for (const [key, session] of next) state.sessions.set(key, session);
  console.log(JSON.stringify({
    event: "agent-feed-catalog-source-ready",
    source: "claude",
    durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
    candidates: candidates.length,
    sessions: next.size,
  }));
}

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

async function reconcileCodex(): Promise<void> {
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

async function reconcilePi(): Promise<void> {
  const startedAt = performance.now();
  const sessions = await scanPiSessions();
  const next = new Map(sessions.map((session) => [sessionKey("pi", session.sessionId), session]));
  for (const [key, session] of [...state.sessions]) {
    if (session.source === "pi" && !next.has(key)) state.sessions.delete(key);
  }
  for (const [key, session] of next) state.sessions.set(key, session);
  console.log(JSON.stringify({
    event: "agent-feed-catalog-source-ready",
    source: "pi",
    durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
    sessions: next.size,
  }));
}

export function registerPiSession(location: PiSessionLocation): void {
  state.sessions.set(sessionKey("pi", location.sessionId), {
    sessionId: location.sessionId,
    source: "pi",
    project: location.projectPath,
    transcriptPath: location.transcriptPath,
    title: location.title,
    lastEventAt: location.lastEventAt,
    entrypoint: "pi",
  });
  broadcast();
}

export function notifyPiSessionChanged(sessionId: string): void {
  const key = sessionKey("pi", sessionId);
  const session = state.sessions.get(key);
  if (!session) return;
  // Restamped here, at the one moment the change is known, rather than left for every
  // consumer to re-derive with a `stat` of its own each time it renders the session.
  // Pi's own watcher rescans on a timer, so this is what keeps the record honest in
  // between: an agent event moves the file before that rescan runs.
  void stat(session.transcriptPath)
    .then((metadata) => {
      const current = state.sessions.get(key);
      if (current) current.lastEventAt = Math.max(current.lastEventAt, metadata.mtimeMs);
    })
    .catch((error) => console.warn("agent feed Pi session metadata probe failed", error))
    .finally(() => scheduleBroadcast());
}

export function resolvePiSession(sessionId: string): PiSessionLocation | undefined {
  const session = findSession("pi", sessionId);
  return session ? piLocation(session) : undefined;
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
function scheduleCodexReconcile(): void {
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

function attachSourceWatchers(): void {
  const claudeWatcher = chokidar.watch(config.claudeProjectsDirectory, {
    ignoreInitial: true,
    depth: 1,
    persistent: true,
    awaitWriteFinish: false,
  });
  const onClaudeCandidate = (path: string): void => {
    void refreshClaudeSession(path).catch((error) => {
      console.error("agent feed Claude candidate reconcile failed", error);
    });
  };
  claudeWatcher.on("add", onClaudeCandidate);
  claudeWatcher.on("change", onClaudeCandidate);
  claudeWatcher.on("unlink", onClaudeCandidate);
  claudeWatcher.on("error", (error) => {
    console.error("agent feed Claude catalog watcher failed", error);
  });
  state.sourceWatchers.push(claudeWatcher);

  const databasePath = resolveStateDbPath();
  if (databasePath) {
    const databaseWatcher = chokidar.watch(
      [databasePath, `${databasePath}-wal`, `${databasePath}-shm`],
      { ignoreInitial: true, persistent: true, awaitWriteFinish: false },
    );
    databaseWatcher.on("add", scheduleCodexReconcile);
    databaseWatcher.on("change", scheduleCodexReconcile);
    databaseWatcher.on("unlink", scheduleCodexReconcile);
    databaseWatcher.on("error", (error) => {
      console.error("agent feed Codex database watcher failed", error);
    });
    state.sourceWatchers.push(databaseWatcher);
  }

  const rolloutRoot = join(config.codexHomeDirectory, "sessions");
  const rolloutWatcher = chokidar.watch(rolloutRoot, {
    ignoreInitial: true,
    depth: 3,
    persistent: true,
    awaitWriteFinish: false,
  });
  // Appearing and disappearing change what the catalog CONTAINS, which only the
  // database can answer. Growing changes what one record SAYS, which the file can.
  const onRolloutMembership = (path: string): void => {
    if (ROLLOUT_PATTERN.test(basename(path))) scheduleCodexReconcile();
  };
  const onRolloutWritten = (path: string): void => {
    if (!ROLLOUT_PATTERN.test(basename(path))) return;
    void refreshCodexRollout(path).catch((error) => {
      console.error("agent feed Codex rollout refresh failed", error);
    });
  };
  rolloutWatcher.on("add", onRolloutMembership);
  rolloutWatcher.on("change", onRolloutWritten);
  rolloutWatcher.on("unlink", onRolloutMembership);
  rolloutWatcher.on("error", (error) => {
    console.error("agent feed Codex rollout watcher failed", error);
  });
  state.sourceWatchers.push(rolloutWatcher);

  const piWatcher = chokidar.watch(config.piSessionsDirectory, {
    ignoreInitial: true,
    depth: 2,
    persistent: true,
    awaitWriteFinish: false,
  });
  const schedulePi = (): void => {
    if (piReconcileTimer) clearTimeout(piReconcileTimer);
    piReconcileTimer = setTimeout(() => {
      piReconcileTimer = null;
      void reconcilePi().then(broadcast).catch((error) => {
        console.error("agent feed Pi catalog reconcile failed", error);
      });
    }, 40);
  };
  piWatcher.on("add", schedulePi);
  piWatcher.on("change", schedulePi);
  piWatcher.on("unlink", schedulePi);
  piWatcher.on("error", (error) => console.error("agent feed Pi catalog watcher failed", error));
  state.sourceWatchers.push(piWatcher);
}

/**
 * The project list for the current catalog.
 *
 * Memoized on the generation, so N subscribers watching the same catalog compute it
 * once between changes rather than once each, every change.
 */
export function projectSummaries(sessions?: Session[]): ProjectSummary[] {
  // An explicitly supplied snapshot is somebody else's view of the world and is not
  // what this generation's memo describes, so it is computed and not stored.
  if (sessions) return computeProjectSummaries(sessions);
  if (projectSummariesMemo?.generation === catalogGeneration) return projectSummariesMemo.value;
  const value = computeProjectSummaries(getSnapshot());
  projectSummariesMemo = { generation: catalogGeneration, value };
  return value;
}

/**
 * Says so when deriving a view took long enough to mean something changed.
 *
 * Both derivations below are folds over records already in memory: the project list
 * is 0.3 ms over 1237 sessions, a project's session list 1-2 ms over 305. They used
 * to read transcripts and take seconds, which is why each one traced its own duration
 * on every emission -- a number worth having when it was 7000. At single-digit
 * milliseconds that same line fires up to 25 times a second per open project to
 * report that nothing happened, which is how a log stops being read.
 *
 * So it reports the overrun instead of the duration. That keeps the one thing the
 * trace was still good for, because the way a transcript body read gets back into
 * this path is quietly, and 50 ms is roughly 25x the honest cost and 140x under what
 * a single body read used to be.
 */
const VIEW_DERIVATION_BUDGET_MS = 50;

function reportSlowDerivation(
  event: string,
  startedAt: number,
  detail: Record<string, unknown>,
): void {
  const durationMs = performance.now() - startedAt;
  if (durationMs < VIEW_DERIVATION_BUDGET_MS) return;
  console.warn(JSON.stringify({
    event,
    durationMs: Math.round(durationMs * 100) / 100,
    budgetMs: VIEW_DERIVATION_BUDGET_MS,
    subscribers: state.subscribers.size,
    ...detail,
  }));
}

function computeProjectSummaries(sessions: Session[]): ProjectSummary[] {
  const startedAt = performance.now();
  const grouped = new Map<string, ProjectSummary>();
  for (const session of sessions) {
    let project = grouped.get(session.project);
    if (!project) {
      project = {
        projectPath: session.project,
        displayName: basename(session.project),
        sourceCounts: { claude: 0, codex: 0 },
        sessionCount: 0,
        lastEventAt: 0,
      };
      grouped.set(session.project, project);
    }
    project.sourceCounts[session.source] = (project.sourceCounts[session.source] ?? 0) + 1;
    project.sessionCount += 1;
    project.lastEventAt = Math.max(project.lastEventAt, session.lastEventAt);
  }
  const projects = [...grouped.values()].sort((left, right) =>
    right.lastEventAt - left.lastEventAt || left.projectPath.localeCompare(right.projectPath)
  );
  reportSlowDerivation("agent-feed-project-snapshot-slow", startedAt, {
    projects: projects.length,
  });
  return projects;
}

function computeActivity(lastEventAt: number, lastTurnClosed: boolean): Bin {
  const age = Date.now() - lastEventAt;
  if (!lastTurnClosed && age < config.liveWindowMs) return "live";
  if (age < config.readyThresholdMs) return "ready";
  if (age < config.staleThresholdMs) return "paused";
  return "cold";
}

/**
 * What a session can do, resolved the one way.
 *
 * A transcript session is read-only unless a live mirror answers for it, in which
 * case it also streams; a Pi session takes its backend's word and falls back to the
 * static Pi table. Exported because the timeline endpoint decides which streams to
 * open from exactly these flags, and a second copy of this rule would be free to
 * disagree with what the session list published.
 */
export function sessionCapabilities(
  source: SourceId,
  sessionId: string,
  resolveAgentSession?: AgentSessionDescriptorResolver,
): AgentSessionCapabilities {
  const descriptor = resolveAgentSession?.(source, sessionId);
  if (source === "pi") return descriptor?.capabilities ?? PI_AGENT_CAPABILITIES;
  return descriptor?.capabilities.canStreamLive
    ? { ...TRANSCRIPT_CAPABILITIES, canStreamLive: true }
    : TRANSCRIPT_CAPABILITIES;
}

/**
 * One session's row, from the record the catalog already holds.
 *
 * Nothing here touches the disk. That is the whole point: this used to walk the
 * transcript body -- every line of it, `JSON.parse` per line -- to recover a title
 * and a turn state, so asking for a project's three most recent rows read all 305 of
 * its transcripts end to end and took seven seconds. Both of those facts now ride the
 * session record, put there by the bounded metadata read that discovered the session,
 * so listing is a projection rather than a scan.
 *
 * Title precedence: whatever the source calls the session, then its opening prompt,
 * then its id. The prompt fallback exists because a titleless session would otherwise
 * render as a UUID; the id is the last resort and its appearance in the list is the
 * standing signal that a source stopped answering.
 */
export function summarizeSession(
  session: Session,
  resolveAgentSession?: AgentSessionDescriptorResolver,
): SessionSummary {
  // Every source resolves a descriptor the same way: a live backend answering for a
  // catalog session is what makes it live, whichever store the session came from.
  const live = resolveAgentSession?.(session.source, session.sessionId);
  // `lastEventAt` is the catalog's, not re-derived here. Both transcript sources stamp
  // it from the file itself during reconciliation, so a second reading taken at
  // emission time could only disagree with the one every other consumer is using.
  const lastEventAt = session.lastEventAt;
  return {
    sessionId: session.sessionId,
    source: session.source,
    // Trimmed here and not only where the record was built, because not every record
    // is built here: a Pi session registered by its backend arrives with whatever
    // title that backend chose, and a row is not the place to find that out.
    title: compactTitle(session.title) ?? compactTitle(session.firstPrompt) ??
      session.sessionId,
    lastEventAt,
    activity: summaryActivity(session, live),
    capabilities: sessionCapabilities(
      session.source,
      session.sessionId,
      resolveAgentSession,
    ),
  };
}

/** Which bin a row lands in, given what the catalog knows and who is answering for it. */
function summaryActivity(
  session: Session,
  live: AgentSessionDescriptor | undefined,
): Bin {
  // Pi takes its backend's word outright, including a non-live answer: the backend is
  // the session's owner, not an observer of it.
  if (session.source === "pi") return live?.activity ?? computeActivity(session.lastEventAt, true);
  // For the transcript sources a live backend can only promote a row, never demote
  // one, because a backend that has not heard of a session says nothing about it
  // rather than saying it is idle.
  if (live?.activity === "live") return "live";
  // A source that could not answer cheaply left the turn state unset, which reads as
  // closed: a session is not shown live on the strength of a missing fact.
  return computeActivity(session.lastEventAt, session.lastTurnClosed ?? true);
}

/**
 * One project's session list, sorted the way it is rendered.
 *
 * Takes the snapshot when the caller already has one -- the inventory stream is
 * handed a snapshot per broadcast, and `getSnapshot()` sorts every session in the
 * catalog to produce it, which is not work worth repeating per open project.
 */
export function sessionSummaries(
  projectPath: string,
  resolveAgentSession?: AgentSessionDescriptorResolver,
  snapshot?: Session[],
): SessionSummary[] {
  const startedAt = performance.now();
  const summaries = (snapshot ?? getSnapshot())
    .filter((session) => session.project === projectPath)
    .map((session) => summarizeSession(session, resolveAgentSession));
  summaries.sort((left, right) =>
    right.lastEventAt - left.lastEventAt ||
    left.source.localeCompare(right.source) ||
    left.sessionId.localeCompare(right.sessionId)
  );
  reportSlowDerivation("agent-feed-session-snapshot-slow", startedAt, {
    projectPath,
    sessions: summaries.length,
  });
  return summaries;
}

/**
 * Runs one source's reconcile and contains its failure to that source.
 *
 * The sources are independent, and the caller of startCatalog treats a startup
 * failure as fatal. So one unreadable transcript store used to kill the whole
 * sidecar, taking every healthy source with it, and the restart read the same
 * unreadable thing and died again: a crash loop that left the agent feed with
 * no data at all rather than the partial data it had. Loud in the log, empty
 * for that source, alive for the rest.
 */
export async function reconcileSource(
  source: SourceId,
  reconcile: () => Promise<void>,
): Promise<void> {
  try {
    await reconcile();
  } catch (error) {
    console.error(JSON.stringify({
      event: "agent-feed-catalog-source-failed",
      source,
      message: error instanceof Error ? error.message : String(error),
    }));
  }
}

function reconcileAllSources(): Promise<void[]> {
  return Promise.all([
    reconcileSource("claude", reconcileClaude),
    reconcileSource("codex", reconcileCodex),
    reconcileSource("pi", reconcilePi),
  ]);
}

export async function startCatalog(): Promise<void> {
  if (state.sourceWatchers.length > 0 || state.watcherState !== "idle") return;
  const startedAt = performance.now();
  state.watcherState = "reconciling";
  await reconcileAllSources();
  attachSourceWatchers();
  state.discoveryTimer = setInterval(() => {
    void reconcileAllSources()
      .then(broadcast)
      .catch((error) => console.error("agent feed catalog safety rescan failed", error));
  }, config.discoveryRescanMs);
  state.watcherState = "live";
  console.log(JSON.stringify({
    event: "agent-feed-catalog-ready",
    durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
    sessions: state.sessions.size,
    projects: projectSummaries().length,
  }));
}

export async function stopCatalog(): Promise<void> {
  if (broadcastTimer) {
    clearTimeout(broadcastTimer);
    broadcastTimer = null;
  }
  if (codexReconcileTimer) {
    clearTimeout(codexReconcileTimer);
    codexReconcileTimer = null;
  }
  // The floor is measured from the last pass of the run that just ended, so a fresh
  // one must not inherit it and sit out its first second.
  codexReconcileSettledAt = 0;
  if (piReconcileTimer) {
    clearTimeout(piReconcileTimer);
    piReconcileTimer = null;
  }
  if (state.discoveryTimer) {
    clearInterval(state.discoveryTimer);
    state.discoveryTimer = null;
  }
  for (const watcher of state.sourceWatchers) await watcher.close();
  state.sourceWatchers.length = 0;
  state.sessions.clear();
  projectSummariesMemo = null;
  state.watcherState = "idle";
}
