// Per-session "digest": compact summary of what a session is doing, suitable
// for the observer agent's overview brief. Computed on demand from the event
// index; no persistence.
//
// The transport contract is parameterized: callers ask for more (longer time
// window, more messages, more files) and the sidecar responds with the slice
// they asked for plus `available` counts so the model can self-throttle the
// next call. See ADR-0003 for the activity-vs-observation split that scopes
// this endpoint.

import { ensureIndexed, getEventCount, readEvents, type ActivityEvent } from './eventIndex.ts';
import { config } from '../config.ts';
import { adapterFor } from './sources/sourceAdapters.ts';
import type {
  ActivityBlock,
  Bin,
  ProjectDigest,
  ProjectDigestOtherSession,
  SessionDigest,
  SessionDigestAvailable,
  SessionDigestMessage,
  SessionDigestTurn,
  SessionDigestToolCount,
  SourceId,
} from './sources/transcriptTypes.ts';
import type { Session } from './sources/transcriptTypes.ts';

export type PrimaryKind = 'work' | 'any';

export function isAuxiliary(session: Session): boolean {
  const adapter = adapterFor(session.source);
  return adapter.isAuxiliarySession?.(session) ?? false;
}

// Defaults stay conservative so a no-argument call is small. Callers ask for
// more via params; truncation flags signal that there's room to widen.
export const DIGEST_DEFAULTS = {
  recentWindowMs: 15 * 60 * 1000,
  messageN: 3,
  fileN: 20,
  toolN: 20,
  textChars: 280,
  scanCap: 5000,
} as const;

export const DIGEST_LIMITS = {
  messageN: 20,
  fileN: 100,
  toolN: 50,
  textChars: 2000,
  scanCap: 20_000,
  // Recent window: at most 7 days. Beyond that, ask for sessionFiles instead.
  recentWindowMs: 7 * 24 * 60 * 60 * 1000,
} as const;

export interface DigestOptions {
  recentWindowMs: number;
  messageN: number;
  fileN: number;
  toolN: number;
  textChars: number;
  scanCap: number;
}

export const PROJECT_DIGEST_DEFAULTS = {
  sessionN: 3,
} as const;

export const PROJECT_DIGEST_LIMITS = {
  sessionN: 10,
} as const;

export interface ProjectDigestOptions {
  sessionN: number;
}

// Tools we treat as touching a file. Source-agnostic: any tool whose input
// carries a path-like key. Listed for callers; not used for matching.
const FILE_INPUT_KEYS = ['file_path', 'path', 'filename', 'notebook_path'] as const;

function extractFile(block: ActivityBlock): string | null {
  if (block.kind !== 'tool_use') return null;
  const input = block.input;
  if (!input || typeof input !== 'object') return null;
  for (const k of FILE_INPUT_KEYS) {
    const v = (input as Record<string, unknown>)[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

interface FirstTextResult {
  text: string;
  truncated: boolean;
}

function firstText(blocks: ActivityBlock[], maxChars: number): FirstTextResult {
  for (const b of blocks) {
    if (b.kind === 'text' && typeof b.text === 'string' && b.text.length > 0) {
      if (b.text.length > maxChars) {
        return { text: b.text.slice(0, maxChars), truncated: true };
      }
      return { text: b.text, truncated: false };
    }
  }
  return { text: '', truncated: false };
}

// Bins a session against the sidecar's thresholds. Liveness is derived here,
// at read time, from two immutable-per-parse facts: is the transcript still
// being appended to (lastEventAt within liveWindowMs), and was the last
// observed turn-boundary signal terminal (lastTurnClosed). Nothing stores
// 'live', so a harness that died mid-turn cannot get stuck in it — the age
// gate moves it to 'ready'/'paused'/'cold' by wall clock. The boundaries
// come from config so the markdown and Agent Panel agree without duplicating
// literals.
export function computeBin(
  lastEventAt: number,
  lastTurnClosed: boolean,
  now: number = Date.now(),
): Bin {
  const age = now - lastEventAt;
  if (!lastTurnClosed && age < config.liveWindowMs) return 'live';
  if (age < config.readyThresholdMs) return 'ready';
  if (age < config.staleThresholdMs) return 'paused';
  return 'cold';
}

function pushBounded<T>(arr: T[], item: T, max: number): boolean {
  if (arr.length >= max) return false;
  arr.push(item);
  return true;
}

interface ChronologicalMessage extends SessionDigestMessage {
  type: 'user' | 'assistant';
}

function buildRecentTurns(messages: ChronologicalMessage[], maxTurns: number): SessionDigestTurn[] {
  if (maxTurns <= 0) return [];
  const turns: SessionDigestTurn[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (msg.type !== 'user') continue;
    let assistantAfter: SessionDigestMessage | null = null;
    for (let j = i + 1; j < messages.length; j++) {
      const candidate = messages[j]!;
      if (candidate.type === 'user') break;
      if (candidate.type === 'assistant') {
        assistantAfter = {
          ts: candidate.ts,
          text: candidate.text,
          truncated: candidate.truncated,
        };
        break;
      }
    }
    turns.push({
      user: { ts: msg.ts, text: msg.text, truncated: msg.truncated },
      assistantAfter,
    });
    if (turns.length >= maxTurns) break;
  }
  return turns;
}

// Walks events newest-first because the recent windows and "last N messages"
// are tail-oriented. Session-wide totals are accumulated in the same pass.
export async function buildDigest(session: Session, opts: DigestOptions): Promise<SessionDigest> {
  await ensureIndexed(session.sessionId, session.transcriptPath);
  const total = getEventCount(session.sessionId);
  const wantScan = Math.min(total, opts.scanCap);
  const startOffset = Math.max(0, total - wantScan);
  const events: ActivityEvent[] = wantScan > 0
    ? await readEvents(session.sessionId, session.transcriptPath, startOffset, wantScan)
    : [];

  const now = Date.now();
  const recentCutoff = now - opts.recentWindowMs;

  const userMessages: SessionDigestMessage[] = [];
  const assistantMessages: SessionDigestMessage[] = [];
  let recentMessagesUserAvailable = 0;
  let recentMessagesAssistantAvailable = 0;
  let lastUserMessageAt: number | null = null;
  let lastAssistantMessageAt: number | null = null;
  const messagesChronological: ChronologicalMessage[] = [];

  const recentFilesOrder: string[] = [];
  const recentFilesSeen = new Set<string>();
  let recentFilesAvailable = 0;

  const sessionFilesOrder: string[] = [];
  const sessionFilesSeen = new Set<string>();

  const recentToolCounts = new Map<string, number>();
  const sessionToolCounts = new Map<string, number>();

  for (const ev of events) {
    if (ev.type !== 'user' && ev.type !== 'assistant') continue;
    const { text, truncated } = firstText(ev.blocks, opts.textChars);
    if (text.length === 0) continue;
    messagesChronological.push({ type: ev.type, ts: ev.ts, text, truncated });
  }

  // Walk newest-first.
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]!;
    const inRecent = ev.ts >= recentCutoff;

    if (ev.type === 'user' || ev.type === 'assistant') {
      const { text, truncated } = firstText(ev.blocks, opts.textChars);
      if (text.length > 0) {
        const msg: SessionDigestMessage = { ts: ev.ts, text, truncated };
        if (ev.type === 'user') {
          if (lastUserMessageAt === null) lastUserMessageAt = ev.ts;
          if (!pushBounded(userMessages, msg, opts.messageN)) {
            recentMessagesUserAvailable++;
          }
        } else {
          if (lastAssistantMessageAt === null) lastAssistantMessageAt = ev.ts;
          if (!pushBounded(assistantMessages, msg, opts.messageN)) {
            recentMessagesAssistantAvailable++;
          }
        }
      }
    }

    for (const block of ev.blocks) {
      if (block.kind !== 'tool_use') continue;
      const toolName = block.tool ?? 'unknown';
      sessionToolCounts.set(toolName, (sessionToolCounts.get(toolName) ?? 0) + 1);
      if (inRecent) {
        recentToolCounts.set(toolName, (recentToolCounts.get(toolName) ?? 0) + 1);
      }

      const file = extractFile(block);
      if (file) {
        if (!sessionFilesSeen.has(file)) {
          sessionFilesSeen.add(file);
          sessionFilesOrder.push(file);
        }
        if (inRecent && !recentFilesSeen.has(file)) {
          recentFilesSeen.add(file);
          if (!pushBounded(recentFilesOrder, file, opts.fileN)) recentFilesAvailable++;
        }
      }
    }
  }

  // Take the head (newest) of each capped collection.
  const recentTools: SessionDigestToolCount[] = Array.from(recentToolCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, opts.toolN)
    .map(([tool, count]) => ({ tool, count }));
  const sessionTools: SessionDigestToolCount[] = Array.from(sessionToolCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, opts.toolN)
    .map(([tool, count]) => ({ tool, count }));
  const sessionFiles = sessionFilesOrder.slice(0, opts.fileN);

  const available: SessionDigestAvailable = {
    eventsScanned: events.length,
    totalEvents: total,
    scanTruncated: total > events.length,
    recentMessagesAvailable: {
      user: userMessages.length + recentMessagesUserAvailable,
      assistant: assistantMessages.length + recentMessagesAssistantAvailable,
    },
    recentFilesAvailable: recentFilesOrder.length + recentFilesAvailable,
    recentToolsAvailable: recentToolCounts.size,
    sessionFilesAvailable: sessionFilesOrder.length,
    sessionToolsAvailable: sessionToolCounts.size,
  };

  return {
    sessionId: session.sessionId,
    source: session.source,
    project: session.project,
    projectName: session.projectName,
    transcriptPath: session.transcriptPath,
    title: session.title,
    firstPrompt: session.firstPrompt,
    lastUserPrompt: session.lastUserPrompt,
    lastSnippet: session.lastSnippet,
    gitBranch: session.gitBranch,
    entrypoint: session.entrypoint,
    tmuxSession: session.tmuxSession,
    tokenUsage: session.tokenUsage,
    auxiliary: isAuxiliary(session),
    lastEventAt: session.lastEventAt,
    lastUserMessageAt,
    lastAssistantMessageAt,
    bin: computeBin(session.lastEventAt, session.lastTurnClosed, now),
    recentMessages: { user: userMessages, assistant: assistantMessages },
    recentTurns: buildRecentTurns(messagesChronological, opts.messageN),
    recentFiles: recentFilesOrder,
    recentTools,
    sessionFiles,
    sessionTools,
    available,
  };
}

// Bin ranking for sort. Live first, then ready, paused, cold. Cross-project
// listings sort by bin then lastEventAt so the observer's headline is the
// most-actionable project, not just the most-recently-touched one.
const BIN_RANK: Record<Bin, number> = { live: 0, ready: 1, paused: 2, cold: 3 };

function sourceOrder(source: SourceId): number {
  return source === 'claude' ? 0 : 1;
}

function uniqueSources(sessions: Session[]): SourceId[] {
  const sources = new Set<SourceId>();
  for (const s of sessions) sources.add(s.source);
  return [...sources].sort((a, b) => sourceOrder(a) - sourceOrder(b));
}

function compactSession(session: Session, now: number): ProjectDigestOtherSession {
  return {
    sessionId: session.sessionId,
    source: session.source,
    bin: computeBin(session.lastEventAt, session.lastTurnClosed, now),
    auxiliary: isAuxiliary(session),
    lastEventAt: session.lastEventAt,
    title: session.title,
    lastUserPrompt: session.lastUserPrompt,
    transcriptPath: session.transcriptPath,
  };
}

// One project digest per project path. Sessions passed in are the complete
// source snapshot selected by the route layer.
//
// `primaryKind` controls which session becomes the headline:
//   - 'work' (default): pick the most-recent NON-auxiliary session. Falls
//     back to the most-recent auxiliary only if the project has nothing
//     else. Auxiliaries still appear in `otherSessions` for inspection.
//   - 'any': pick the most-recent session regardless of kind. Use when the
//     caller wants to see review/judge runs surfaced as headlines.
export async function buildProjectDigests(
  sessions: Session[],
  opts: DigestOptions,
  primaryKind: PrimaryKind = 'work',
  now: number = Date.now(),
  projectOpts: ProjectDigestOptions = PROJECT_DIGEST_DEFAULTS,
): Promise<ProjectDigest[]> {
  // Group by project path. Source is provenance, not the observer's project
  // identity.
  const groups = new Map<string, Session[]>();
  for (const s of sessions) {
    const arr = groups.get(s.project);
    if (arr) arr.push(s);
    else groups.set(s.project, [s]);
  }

  const projects: ProjectDigest[] = [];
  for (const [project, group] of groups) {
    group.sort((a, b) => b.lastEventAt - a.lastEventAt);
    const sources = uniqueSources(group);

    // Pick primary. In work mode, scan for the first non-auxiliary; if every
    // session in the group is auxiliary, fall through to the most recent so
    // the project still has a headline.
    let primary = group[0]!;
    if (primaryKind === 'work') {
      const work = group.find((s) => !isAuxiliary(s));
      if (work) primary = work;
    }
    const primaryDigest = await buildDigest(primary, opts);

    const workSessions = group.filter((s) => !isAuxiliary(s));
    const auxiliarySessions = group.filter((s) => isAuxiliary(s));
    const digestCandidates = primaryKind === 'any' || workSessions.length === 0
      ? group
      : [...workSessions, ...auxiliarySessions];
    const selected = digestCandidates.slice(0, projectOpts.sessionN);
    const selectedIds = new Set(selected.map((s) => s.sessionId));
    const sessionDigests: SessionDigest[] = [];
    for (const session of selected) {
      if (session.sessionId === primary.sessionId) sessionDigests.push(primaryDigest);
      else sessionDigests.push(await buildDigest(session, opts));
    }

    const otherSessions = group
      .filter((s) => s.sessionId !== primary.sessionId && !selectedIds.has(s.sessionId))
      .map((s) => compactSession(s, now));

    const sessionCountBySource: Partial<Record<SourceId, number>> = {};
    for (const s of group) {
      sessionCountBySource[s.source] = (sessionCountBySource[s.source] ?? 0) + 1;
    }

    const evidenceDigests = sessionDigests.some((d) => d.sessionId === primaryDigest.sessionId)
      ? sessionDigests
      : [primaryDigest, ...sessionDigests];
    const recentTurns = evidenceDigests
      .flatMap((d) => d.recentTurns)
      .sort((a, b) => b.user.ts - a.user.ts)
      .slice(0, opts.messageN);
    const latestUserPrompt = group.find((s) => s.lastUserPrompt)?.lastUserPrompt
      ?? primaryDigest.recentMessages.user[0]?.text;
    const latestAssistantOutcome = evidenceDigests
      .flatMap((d) => d.recentMessages.assistant)
      .sort((a, b) => b.ts - a.ts)[0]?.text;

    projects.push({
      project: primary.project,
      projectName: primary.projectName,
      source: primary.source,
      sources,
      lastEventAt: group[0]!.lastEventAt,
      bin: primaryDigest.bin,
      primary: primaryDigest,
      sessions: sessionDigests,
      otherSessions,
      evidence: {
        sessionCountBySource,
        auxiliarySessionCount: auxiliarySessions.length,
        latestUserPrompt,
        latestAssistantOutcome,
        recentTurns,
        provenance: {
          sessionIds: group.map((s) => s.sessionId),
          transcriptPaths: group.map((s) => s.transcriptPath),
        },
      },
    });
  }

  projects.sort((a, b) => {
    if (a.bin === null && b.bin === null) return a.project.localeCompare(b.project);
    if (a.bin === null) return 1;
    if (b.bin === null) return -1;
    const r = BIN_RANK[a.bin] - BIN_RANK[b.bin];
    if (r !== 0) return r;
    return (b.lastEventAt ?? 0) - (a.lastEventAt ?? 0);
  });

  return projects;
}

// Parse a positive integer query param, clamped to [min, max]. Returns the
// fallback when the param is absent or unparseable.
export function intParam(url: URL, name: string, fallback: number, min: number, max: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  const n = Number(raw) | 0;
  if (!Number.isFinite(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

export function parseDigestOptions(url: URL): DigestOptions {
  return {
    recentWindowMs: intParam(
      url, 'recentWindowMs',
      DIGEST_DEFAULTS.recentWindowMs, 1000, DIGEST_LIMITS.recentWindowMs,
    ),
    messageN: intParam(url, 'messages', DIGEST_DEFAULTS.messageN, 0, DIGEST_LIMITS.messageN),
    fileN: intParam(url, 'files', DIGEST_DEFAULTS.fileN, 0, DIGEST_LIMITS.fileN),
    toolN: intParam(url, 'tools', DIGEST_DEFAULTS.toolN, 0, DIGEST_LIMITS.toolN),
    textChars: intParam(url, 'textChars', DIGEST_DEFAULTS.textChars, 40, DIGEST_LIMITS.textChars),
    scanCap: intParam(url, 'scanCap', DIGEST_DEFAULTS.scanCap, 1, DIGEST_LIMITS.scanCap),
  };
}

export function parseProjectDigestOptions(url: URL): ProjectDigestOptions {
  return {
    sessionN: intParam(
      url, 'sessions',
      PROJECT_DIGEST_DEFAULTS.sessionN, 0, PROJECT_DIGEST_LIMITS.sessionN,
    ),
  };
}
