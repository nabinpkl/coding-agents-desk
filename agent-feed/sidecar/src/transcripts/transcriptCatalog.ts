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
import type {
  Bin,
  ParsedLine,
  Session,
  SourceAdapter,
  SourceId,
} from "./sources/transcriptTypes.ts";
import type { ProjectSummary, SessionSummary } from "@agentdesk/agent-feed-wire";

// What the catalog publishes on /api/inventory and /api/sessions, declared once in
// agent-feed/wire and parsed by the Agent Panel from that same declaration.
export type { ProjectSummary, SessionSummary } from "@agentdesk/agent-feed-wire";

const SUMMARY_READ_BYTES = 1024 * 1024;
const SUMMARY_TITLE_CHARACTERS = 240;
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
 * Which version of the catalog the derived views below were computed against.
 *
 * Everything a subscriber reads -- the project list, a project's session list -- is a
 * projection of one snapshot, identical for every subscriber. Keying the projections
 * on this counter is what makes them computed once per change instead of once per
 * change per subscriber, which is what they used to be.
 */
let catalogGeneration = 0;
let projectSummariesMemo: { generation: number; value: ProjectSummary[] } | null = null;
const sessionSummariesMemo = new Map<
  string,
  { generation: number; value: Promise<SessionSummary[]> }
>();

function broadcast(): void {
  catalogGeneration += 1;
  // Dropped rather than left to expire by generation, so a project that stops being
  // watched stops being held here too.
  sessionSummariesMemo.clear();
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

/** Forgets everything derived for a session that left the catalog. */
function forgetSession(key: string): void {
  state.sessions.delete(key);
  sessionProbes.delete(key);
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
  } = {},
): Session {
  return {
    sessionId,
    source,
    project,
    transcriptPath,
    lastEventAt,
    ...metadata,
    title: compactTitle(metadata.title),
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

async function readClaudeCandidate(filePath: string): Promise<Session | null> {
  const sessionId = claudeAdapter.filePathToSessionId(filePath);
  if (!sessionId || !isClaudeSessionCandidate(filePath)) return null;
  const header = await claudeAdapter.readHeader(filePath);
  if (!header?.cwd) return null;
  const project = await canonicalDirectory(header.cwd);
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
    if (session.source === "claude" && !next.has(key)) forgetSession(key);
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
  const resolved = await Promise.all(rows.map(async (row): Promise<Session | null> => {
    if (!row.id || !row.cwd || !row.rollout_path) return null;
    const project = await canonicalDirectory(row.cwd);
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
    return makeSession("codex", row.id, project, row.rollout_path, updatedAt, {
      title: row.title.trim() || undefined,
      gitBranch: row.git_branch ?? undefined,
    });
  }));
  const next = new Map(
    resolved
      .filter((session): session is Session => session !== null)
      .map((session) => [sessionKey(session.source, session.sessionId), session]),
  );
  for (const [key, session] of [...state.sessions]) {
    if (session.source === "codex" && !next.has(key)) forgetSession(key);
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
    if (session.source === "pi" && !next.has(key)) forgetSession(key);
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

function scheduleCodexReconcile(): void {
  if (codexReconcileTimer) clearTimeout(codexReconcileTimer);
  codexReconcileTimer = setTimeout(() => {
    codexReconcileTimer = null;
    void reconcileCodex().then(broadcast).catch((error) => {
      console.error("agent feed Codex catalog reconcile failed", error);
    });
  }, 40);
}

function attachSourceWatchers(): void {
  const claudeWatcher = chokidar.watch(config.claudeProjectsDirectory, {
    ignoreInitial: true,
    depth: 1,
    persistent: true,
    awaitWriteFinish: false,
  });
  const onClaudeCandidate = (path: string): void => {
    if (!isClaudeSessionCandidate(path)) return;
    void readClaudeCandidate(path).then((session) => {
      const sessionId = claudeAdapter.filePathToSessionId(path);
      if (!sessionId) return;
      const key = sessionKey("claude", sessionId);
      if (session) state.sessions.set(key, session);
      else forgetSession(key);
      scheduleBroadcast();
    }).catch((error) => {
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
  const onRollout = (path: string): void => {
    if (ROLLOUT_PATTERN.test(basename(path))) scheduleCodexReconcile();
  };
  rolloutWatcher.on("add", onRollout);
  rolloutWatcher.on("change", onRollout);
  rolloutWatcher.on("unlink", onRollout);
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
  console.log(JSON.stringify({
    event: "agent-feed-project-snapshot",
    durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
    projects: projects.length,
    subscribers: state.subscribers.size,
  }));
  return projects;
}

function firstText(event: ParsedLine): string | undefined {
  for (const block of event.blocks) {
    if (block.kind === "text" && block.text?.trim()) return block.text.trim();
  }
  return undefined;
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
 * Everything a session summary needs from the transcript body, and how much of the
 * file it has been read out of.
 *
 * The summary used to be re-derived from scratch on every emission: the head window,
 * the tail window, and then the WHOLE file again for the title scan, per subscriber,
 * per catalog change. A running agent broadcasts per written line, so the cost of
 * showing a project's session list was its transcripts re-read end to end, repeatedly.
 *
 * Transcripts are append-only, so this is built once and extended by whatever was
 * appended since, which is the same shape the event index already uses one layer down.
 */
interface SessionProbe {
  /** Bytes consumed so far. Always lands on a line boundary. */
  scannedBytes: number;
  /**
   * The catalog stamp this probe is current for.
   *
   * The catalog is the one place that learns a session changed, so its record is what
   * says whether this is stale. Matching means the file cannot have moved, and the
   * probe is reused without so much as a `stat`.
   */
  lastEventAt: number;
  title?: string;
  customTitle?: string;
  aiTitle?: string;
  firstPrompt?: string;
  lastUserPrompt?: string;
  lastTurnClosed: boolean;
}

const sessionProbes = new Map<string, SessionProbe>();

function applyProbeLine(adapter: SourceAdapter, probe: SessionProbe, line: string): void {
  const parsed = adapter.processLine(line);
  if (!parsed) return;
  if (parsed.title?.trim()) {
    const title = compactTitle(parsed.title);
    // Claude Code shows a user-set custom title over the auto one, and either over
    // whatever the header carried, so the three are kept apart and ranked at the end
    // rather than overwriting each other in file order.
    if (line.includes('"type":"custom-title"')) probe.customTitle = title;
    else if (line.includes('"type":"ai-title"')) probe.aiTitle = title;
    else probe.title = title;
  }
  if (parsed.turnClosed !== undefined) probe.lastTurnClosed = parsed.turnClosed;
  if (parsed.event?.type === "user") {
    const prompt = firstText(parsed.event);
    if (prompt) {
      probe.firstPrompt ??= compactTitle(prompt.slice(0, 120));
      probe.lastUserPrompt = compactTitle(prompt);
    }
  }
}

/**
 * The session's probe, extended over whatever the transcript gained since it was
 * last read. Null when the file cannot be read at all.
 */
async function readSessionProbe(session: Session): Promise<SessionProbe | null> {
  const key = sessionKey(session.source, session.sessionId);
  const existing = sessionProbes.get(key);
  if (existing && existing.lastEventAt === session.lastEventAt) return existing;
  let metadata: Awaited<ReturnType<typeof stat>>;
  try {
    metadata = await stat(session.transcriptPath);
  } catch {
    return null;
  }
  // A file shorter than what was read from it was rewritten, not appended to, and
  // nothing carried forward from the old contents can be trusted.
  const probe: SessionProbe = existing && metadata.size >= existing.scannedBytes
    ? existing
    : { scannedBytes: 0, lastEventAt: session.lastEventAt, lastTurnClosed: true };
  probe.lastEventAt = session.lastEventAt;
  const adapter = session.source === "claude" ? claudeAdapter : codexAdapter;
  // Chunked, and only over complete lines: a partial trailing line is left unconsumed
  // so the next pass reads it whole rather than parsing half of it and skipping the
  // rest. Same walk the event index does, for the same reason.
  let cursor = probe.scannedBytes;
  let carry = new Uint8Array();
  let carryStart = probe.scannedBytes;
  const decoder = new TextDecoder();
  while (cursor < metadata.size) {
    const chunkEnd = Math.min(metadata.size, cursor + SUMMARY_READ_BYTES);
    const chunk = await Bun.file(session.transcriptPath).slice(cursor, chunkEnd).bytes();
    const combined = new Uint8Array(carry.byteLength + chunk.byteLength);
    combined.set(carry, 0);
    combined.set(chunk, carry.byteLength);
    let lineStart = 0;
    for (let index = 0; index < combined.byteLength; index += 1) {
      if (combined[index] !== 0x0a) continue;
      if (index > lineStart) {
        applyProbeLine(adapter, probe, decoder.decode(combined.subarray(lineStart, index)));
      }
      lineStart = index + 1;
    }
    carry = combined.slice(lineStart);
    carryStart += lineStart;
    cursor = chunkEnd;
  }
  probe.scannedBytes = carryStart;
  sessionProbes.set(key, probe);
  return probe;
}

export async function probeSession(
  session: Session,
  resolveAgentSession?: AgentSessionDescriptorResolver,
): Promise<SessionSummary> {
  const capabilities = sessionCapabilities(
    session.source,
    session.sessionId,
    resolveAgentSession,
  );
  // Every source resolves a descriptor the same way: a live backend answering for a
  // catalog session is what makes it live, whichever store the session came from.
  const live = resolveAgentSession?.(session.source, session.sessionId);
  // `lastEventAt` is the catalog's, not re-derived here. Both transcript sources stamp
  // it from the file itself during reconciliation, so a second reading taken at
  // emission time could only disagree with the one every other consumer is using.
  const lastEventAt = session.lastEventAt;
  if (session.source === "pi") {
    return {
      sessionId: session.sessionId,
      source: session.source,
      title: compactTitle(session.title) ?? session.sessionId,
      lastEventAt,
      activity: live?.activity ?? computeActivity(lastEventAt, true),
      capabilities,
    };
  }
  const probe = await readSessionProbe(session);
  if (!probe) {
    return {
      sessionId: session.sessionId,
      source: session.source,
      title: compactTitle(session.title) ?? session.sessionId,
      lastEventAt,
      activity: live?.activity === "live" ? "live" : computeActivity(lastEventAt, true),
      capabilities,
    };
  }
  return {
    sessionId: session.sessionId,
    source: session.source,
    title: probe.customTitle ?? probe.aiTitle ?? probe.title ?? compactTitle(session.title) ??
      probe.firstPrompt ?? probe.lastUserPrompt ?? session.sessionId,
    lastEventAt,
    activity: live?.activity === "live"
      ? "live"
      : computeActivity(lastEventAt, probe.lastTurnClosed),
    capabilities,
  };
}

/**
 * One project's session list for the current catalog.
 *
 * Memoized on the generation like the project list, and for a stronger reason: every
 * viewer of a project asks the same question of the same files, and the answer cannot
 * differ between them. Two agent windows expanded on one project now share the work
 * instead of each doing it.
 *
 * The promise is what is stored, not the result, so callers that arrive while the
 * first one is still reading join it rather than starting a second pass.
 */
export function sessionSummaries(
  projectPath: string,
  resolveAgentSession?: AgentSessionDescriptorResolver,
): Promise<SessionSummary[]> {
  const memo = sessionSummariesMemo.get(projectPath);
  if (memo?.generation === catalogGeneration) return memo.value;
  const generation = catalogGeneration;
  const value = computeSessionSummaries(projectPath, resolveAgentSession).catch((error) => {
    // A failed read must not be remembered as this generation's answer, or the retry
    // that follows it would be handed the same failure without touching the disk.
    if (sessionSummariesMemo.get(projectPath)?.value === value) {
      sessionSummariesMemo.delete(projectPath);
    }
    throw error;
  });
  sessionSummariesMemo.set(projectPath, { generation, value });
  return value;
}

async function computeSessionSummaries(
  projectPath: string,
  resolveAgentSession?: AgentSessionDescriptorResolver,
): Promise<SessionSummary[]> {
  const startedAt = performance.now();
  const sessions = getSnapshot().filter((session) => session.project === projectPath);
  const summaries = await Promise.all(
    sessions.map((session) => probeSession(session, resolveAgentSession)),
  );
  summaries.sort((left, right) =>
    right.lastEventAt - left.lastEventAt ||
    left.source.localeCompare(right.source) ||
    left.sessionId.localeCompare(right.sessionId)
  );
  console.log(JSON.stringify({
    event: "agent-feed-session-snapshot",
    projectPath,
    durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
    sessions: summaries.length,
    subscribers: state.subscribers.size,
  }));
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
  sessionProbes.clear();
  sessionSummariesMemo.clear();
  projectSummariesMemo = null;
  state.watcherState = "idle";
}
