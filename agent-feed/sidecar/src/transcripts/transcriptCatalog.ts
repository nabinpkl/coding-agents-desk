import chokidar, { type FSWatcher } from "chokidar";
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { config } from "../config.ts";
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
  SourceId,
} from "./sources/transcriptTypes.ts";

export interface ProjectSummary {
  projectPath: string;
  displayName: string;
  sourceCounts: { claude: number; codex: number };
  sessionCount: number;
  lastEventAt: number;
}

export interface SessionSummary {
  sessionId: string;
  source: SourceId;
  title: string;
  lastEventAt: number;
  activity: Bin;
}

const HEADER_PROBE_BYTES = 32 * 1024;
const SUMMARY_TITLE_CHARACTERS = 240;
const CLAUDE_SESSION_PATTERN = /^[0-9a-f-]{36}\.jsonl$/i;
const ROLLOUT_PATTERN = /^rollout-[\d-]+T[\d-]+-([0-9a-f-]{36})\.jsonl$/i;
let codexReconcileTimer: ReturnType<typeof setTimeout> | null = null;

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

function broadcast(): void {
  const snapshot = getSnapshot();
  for (const listener of state.subscribers) {
    try {
      listener(snapshot);
    } catch (error) {
      console.error("agent feed catalog subscriber failed", error);
    }
  }
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

function readCodexRows(): CodexThreadRow[] {
  const databasePath = resolveStateDbPath();
  if (!databasePath || !existsSync(databasePath)) return [];
  const database = new Database(databasePath, { readonly: true });
  try {
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

async function reconcileCodex(): Promise<void> {
  const startedAt = performance.now();
  const rows = readCodexRows();
  const resolved = await Promise.all(rows.map(async (row): Promise<Session | null> => {
    if (!row.id || !row.cwd || !row.rollout_path) return null;
    const project = await canonicalDirectory(row.cwd);
    if (!project) return null;
    const updatedAt = row.updated_at_ms ?? row.updated_at * 1000;
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
      else state.sessions.delete(key);
      broadcast();
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
}

export function projectSummaries(sessions: Session[] = getSnapshot()): ProjectSummary[] {
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
    project.sourceCounts[session.source] += 1;
    project.sessionCount += 1;
    project.lastEventAt = Math.max(project.lastEventAt, session.lastEventAt);
  }
  const projects = [...grouped.values()].sort((left, right) =>
    right.lastEventAt - left.lastEventAt || left.projectPath.localeCompare(right.projectPath)
  );
  const bytes = new TextEncoder().encode(JSON.stringify({ projects })).byteLength;
  console.log(JSON.stringify({
    event: "agent-feed-project-snapshot",
    durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
    bytes,
    projects: projects.length,
    subscribers: state.subscribers.size,
    transcriptBodyReads: 0,
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

export async function probeSession(session: Session): Promise<SessionSummary> {
  const adapter = session.source === "claude" ? claudeAdapter : codexAdapter;
  let metadata: Awaited<ReturnType<typeof stat>>;
  try {
    metadata = await stat(session.transcriptPath);
  } catch {
    return {
      sessionId: session.sessionId,
      source: session.source,
      title: compactTitle(session.title) ?? session.sessionId,
      lastEventAt: session.lastEventAt,
      activity: computeActivity(session.lastEventAt, true),
    };
  }
  const file = Bun.file(session.transcriptPath);
  const ranges = metadata.size <= HEADER_PROBE_BYTES * 2
    ? [{ start: 0, end: metadata.size }]
    : [
      { start: 0, end: HEADER_PROBE_BYTES },
      { start: metadata.size - HEADER_PROBE_BYTES, end: metadata.size },
    ];
  let title = compactTitle(session.title);
  let firstPrompt: string | undefined;
  let lastUserPrompt: string | undefined;
  let lastTurnClosed = true;
  for (const range of ranges) {
    const text = await file.slice(range.start, range.end).text();
    const lines = text.split("\n");
    if (range.start > 0) lines.shift();
    for (const line of lines) {
      if (!line) continue;
      const parsed = adapter.processLine(line);
      if (!parsed) continue;
      if (parsed.title?.trim()) title = compactTitle(parsed.title);
      if (parsed.turnClosed !== undefined) lastTurnClosed = parsed.turnClosed;
      if (parsed.event?.type === "user") {
        const prompt = firstText(parsed.event);
        if (prompt) {
          firstPrompt ??= compactTitle(prompt.slice(0, 120));
          lastUserPrompt = compactTitle(prompt);
        }
      }
    }
  }
  const lastEventAt = Math.max(session.lastEventAt, metadata.mtimeMs);
  return {
    sessionId: session.sessionId,
    source: session.source,
    title: title ?? firstPrompt ?? lastUserPrompt ?? session.sessionId,
    lastEventAt,
    activity: computeActivity(lastEventAt, lastTurnClosed),
  };
}

export async function sessionSummaries(projectPath: string): Promise<SessionSummary[]> {
  const startedAt = performance.now();
  const sessions = getSnapshot().filter((session) => session.project === projectPath);
  const summaries = await Promise.all(sessions.map(probeSession));
  summaries.sort((left, right) =>
    right.lastEventAt - left.lastEventAt ||
    left.source.localeCompare(right.source) ||
    left.sessionId.localeCompare(right.sessionId)
  );
  const bytes = new TextEncoder().encode(JSON.stringify({ projectPath, sessions: summaries })).byteLength;
  console.log(JSON.stringify({
    event: "agent-feed-session-snapshot",
    projectPath,
    durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
    bytes,
    sessions: summaries.length,
    subscribers: state.subscribers.size,
  }));
  return summaries;
}

export async function startCatalog(): Promise<void> {
  if (state.sourceWatchers.length > 0 || state.watcherState !== "idle") return;
  const startedAt = performance.now();
  state.watcherState = "reconciling";
  await Promise.all([reconcileClaude(), reconcileCodex()]);
  attachSourceWatchers();
  state.discoveryTimer = setInterval(() => {
    void Promise.all([reconcileClaude(), reconcileCodex()])
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
  if (codexReconcileTimer) {
    clearTimeout(codexReconcileTimer);
    codexReconcileTimer = null;
  }
  if (state.discoveryTimer) {
    clearInterval(state.discoveryTimer);
    state.discoveryTimer = null;
  }
  for (const watcher of state.sourceWatchers) await watcher.close();
  state.sourceWatchers.length = 0;
  state.sessions.clear();
  state.watcherState = "idle";
}
