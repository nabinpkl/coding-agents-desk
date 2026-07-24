import { expect, test } from 'bun:test';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  maybeReconcileSessionProject,
  chooseBootScan,
  resolveStrayProject,
} from './transcriptWatcher.ts';
import { claudeAdapter } from './sources/claudeTranscript.ts';
import type { Session, SourceId } from './sources/transcriptTypes.ts';

function session(project: string): Session {
  return {
    sessionId: 's1',
    source: 'claude',
    project,
    projectName: project.split('/').pop() ?? project,
    transcriptPath: '/tmp/s1.jsonl',
    lastTurnClosed: false,
    lastEventAt: 0,
    lastSnippet: '',
    knownSize: 0,
  };
}

test('Claude adapter exposes top-level cwd from transcript lines', () => {
  const result = claudeAdapter.processLine(JSON.stringify({
    type: 'user',
    timestamp: '2026-06-07T05:00:00.000Z',
    cwd: '/Users/dev/projects/agent-workspace-ide',
    message: { role: 'user', content: 'continue' },
  }));

  expect(result?.cwd).toBe('/Users/dev/projects/agent-workspace-ide');
});

test('project reconciliation moves to latest cwd when original path is gone and latest path exists', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-feed-reconcile-'));
  const oldProject = join(dir, 'code-editor-from-scratch');
  const newProject = join(dir, 'agent-workspace-ide');
  await mkdir(newProject);

  const s = session(oldProject);
  const changed = await maybeReconcileSessionProject(s, newProject);

  expect(changed).toBe(true);
  expect(s.project).toBe(newProject);
  expect(s.projectName).toBe('agent-workspace-ide');
});

test('project reconciliation keeps original project when both paths exist', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-feed-reconcile-both-'));
  const oldProject = join(dir, 'code-editor-from-scratch');
  const newProject = join(dir, 'agent-workspace-ide');
  await mkdir(oldProject);
  await mkdir(newProject);

  const s = session(oldProject);
  const changed = await maybeReconcileSessionProject(s, newProject);

  expect(changed).toBe(false);
  expect(s.project).toBe(oldProject);
  expect(s.projectName).toBe('code-editor-from-scratch');
});

const HOUR = 60 * 60 * 1000;
const NOW = 1_000_000_000_000;

// Regression: a warm-cache session whose project path vanished while the sidecar
// was down, with a transcript that has NOT grown since the last cache save.
// Before the fix this routed to `drain`, which early-returns on the zero-length
// byte delta and never reaches `maybeReconcileSessionProject`, so the rename was
// silently dropped. It must route to `cold-probe`, which re-reads the tail.
test('boot scan re-probes a byte-unchanged session whose project path vanished', () => {
  const scan = chooseBootScan({
    isNew: false,
    knownSize: 4096, // == st.size, so a drain would have nothing to read
    lastEventAt: NOW - 1000, // mtime <= lastEventAt: would be "trust-cache" if path existed
    mtimeMs: NOW - 1000,
    watcherIsLive: false,
    cachedProjectMissing: true,
  });
  expect(scan).toBe('cold-probe');
});

test('boot scan re-probes an old session whose project path vanished', () => {
  const scan = chooseBootScan({
    isNew: false,
    knownSize: 4096,
    lastEventAt: NOW - 2 * HOUR,
    mtimeMs: NOW - 2 * HOUR,
    watcherIsLive: false,
    cachedProjectMissing: true,
  });
  expect(scan).toBe('cold-probe');
});

test('boot scan trusts the cache for an unchanged session whose project still exists', () => {
  const scan = chooseBootScan({
    isNew: false,
    knownSize: 4096,
    lastEventAt: NOW - 1000,
    mtimeMs: NOW - 1000,
    watcherIsLive: false,
    cachedProjectMissing: false,
  });
  expect(scan).toBe('trust-cache');
});

test('boot scan drains a cached session with no cached lastEventAt', () => {
  // Cache carried the byte cursor but no event timestamp: the tail loop
  // consumes the delta (which may be zero) instead of guessing.
  const scan = chooseBootScan({
    isNew: false,
    knownSize: 4096,
    lastEventAt: 0,
    mtimeMs: NOW - 2 * HOUR,
    watcherIsLive: false,
    cachedProjectMissing: false,
  });
  expect(scan).toBe('drain');
});

test('boot scan cold-probes a brand-new session during boot reconcile', () => {
  const scan = chooseBootScan({
    isNew: true,
    knownSize: 0,
    lastEventAt: 0,
    mtimeMs: NOW - 1000,
    watcherIsLive: false,
    cachedProjectMissing: false,
  });
  expect(scan).toBe('cold-probe');
});

test('boot scan drains a recently-grown warm session', () => {
  const scan = chooseBootScan({
    isNew: false,
    knownSize: 2048, // < st.size; there is a delta to consume
    lastEventAt: NOW - 5000,
    mtimeMs: NOW - 1000, // mtime > lastEventAt: file grew, not "trust-cache"
    watcherIsLive: false,
    cachedProjectMissing: false,
  });
  expect(scan).toBe('drain');
});

test('boot scan drains (never cold-probes) once the watcher is live', () => {
  const scan = chooseBootScan({
    isNew: true,
    knownSize: 0,
    lastEventAt: 0,
    mtimeMs: NOW - 1000,
    watcherIsLive: true,
    cachedProjectMissing: false,
  });
  expect(scan).toBe('drain');
});

test('project reconciliation keeps original project when latest cwd does not exist', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-feed-reconcile-missing-new-'));
  const oldProject = join(dir, 'code-editor-from-scratch');
  const newProject = join(dir, 'agent-workspace-ide');
  await mkdir(oldProject);

  const s = session(oldProject);
  const changed = await maybeReconcileSessionProject(s, newProject);

  expect(changed).toBe(false);
  expect(s.project).toBe(oldProject);
  expect(s.projectName).toBe('code-editor-from-scratch');
});

// --- sibling-based stray healing (idle session whose project was renamed) ---

function strayCandidate(opts: {
  sessionId: string;
  source?: SourceId;
  project: string;
  slugDir: string;
  lastEventAt?: number;
}): Session {
  return {
    sessionId: opts.sessionId,
    source: opts.source ?? 'claude',
    project: opts.project,
    projectName: opts.project.split('/').pop() ?? opts.project,
    transcriptPath: join(opts.slugDir, `${opts.sessionId}.jsonl`),
    lastTurnClosed: true,
    lastEventAt: opts.lastEventAt ?? 0,
    lastSnippet: '',
    knownSize: 0,
  };
}

const SLUG = '/Users/dev/.claude/projects/-Users-dev-projects-finops-agent';
const ENGINE = '/Users/dev/projects/finops-sidecar';
const AGENT = '/Users/dev/projects/finops-agent';

test('stray adopts the freshest existing sibling cwd in the same slug dir', () => {
  const stray = strayCandidate({ sessionId: 'stray', project: ENGINE, slugDir: SLUG });
  const older = strayCandidate({ sessionId: 'a', project: AGENT, slugDir: SLUG, lastEventAt: 10 });
  const newer = strayCandidate({ sessionId: 'b', project: AGENT, slugDir: SLUG, lastEventAt: 20 });
  const exists = (p: string): boolean => p === AGENT;

  expect(resolveStrayProject(stray, [stray, older, newer], exists)).toBe(AGENT);
});

test('stray stays put when no sibling in the slug has an existing path', () => {
  const stray = strayCandidate({ sessionId: 'stray', project: ENGINE, slugDir: SLUG });
  const sibling = strayCandidate({ sessionId: 'a', project: ENGINE, slugDir: SLUG });
  const exists = (): boolean => false; // whole slug is dead: a deletion, not a rename

  expect(resolveStrayProject(stray, [stray, sibling], exists)).toBeNull();
});

test('stray does not adopt a live session from a different slug dir', () => {
  const stray = strayCandidate({ sessionId: 'stray', project: ENGINE, slugDir: SLUG });
  const otherSlug = strayCandidate({
    sessionId: 'a',
    project: AGENT,
    slugDir: '/Users/dev/.claude/projects/-Users-dev-projects-other',
  });
  const exists = (p: string): boolean => p === AGENT;

  expect(resolveStrayProject(stray, [stray, otherSlug], exists)).toBeNull();
});

test('codex strays are not healed (no project-slug co-location signal)', () => {
  const stray = strayCandidate({ sessionId: 'stray', source: 'codex', project: ENGINE, slugDir: SLUG });
  const sibling = strayCandidate({ sessionId: 'a', source: 'codex', project: AGENT, slugDir: SLUG });
  const exists = (p: string): boolean => p === AGENT;

  expect(resolveStrayProject(stray, [stray, sibling], exists)).toBeNull();
});
