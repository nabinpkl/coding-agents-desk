import { afterEach, expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildProjectDigests, computeBin, type DigestOptions } from './projectDigest.ts';
import { config } from '../config.ts';
import { state } from './transcriptState.ts';
import type { Session } from './sources/transcriptTypes.ts';

const opts: DigestOptions = {
  recentWindowMs: 60 * 60 * 1000,
  messageN: 3,
  fileN: 10,
  toolN: 10,
  textChars: 1000,
  scanCap: 100,
};

afterEach(() => {
  state.sessions.clear();
  state.eventByteOffsets.clear();
  state.indexed.clear();
  state.indexBuilds.clear();
});

async function writeJsonl(file: string, rows: unknown[]): Promise<void> {
  await Bun.write(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
}

function register(session: Session): Session {
  state.sessions.set(session.sessionId, session);
  return session;
}

// --- computeBin: liveness derived at read time, never stored ---

const NOW = 1_750_000_000_000;

test('open turn with recent writes bins live', () => {
  expect(computeBin(NOW - 1000, false, NOW)).toBe('live');
});

test('closed turn with recent writes bins ready, not live', () => {
  expect(computeBin(NOW - 1000, true, NOW)).toBe('ready');
});

test('corpse (open turn, no recent writes) ages out of live by clock', () => {
  // The stuck-working regression: a harness that died mid-turn never writes a
  // terminal marker. lastTurnClosed stays false forever, but the recency gate
  // moves the session out of 'live' on its own.
  const afterLiveWindow = NOW - config.liveWindowMs;
  expect(computeBin(afterLiveWindow, false, NOW)).toBe('ready');
  expect(computeBin(NOW - config.readyThresholdMs, false, NOW)).toBe('paused');
  expect(computeBin(NOW - config.staleThresholdMs, false, NOW)).toBe('cold');
});

test('closed turn bins paused then cold as it ages', () => {
  expect(computeBin(NOW - config.readyThresholdMs, true, NOW)).toBe('paused');
  expect(computeBin(NOW - config.staleThresholdMs, true, NOW)).toBe('cold');
});

test('project digest combines Claude and Codex sessions by project path', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-feed-digest-'));
  const project = join(dir, 'mixed-project');
  const claudePath = join(dir, 'claude.jsonl');
  const codexPath = join(dir, 'codex.jsonl');

  await writeJsonl(claudePath, [
    {
      type: 'user',
      timestamp: '2026-05-31T01:00:00.000Z',
      message: { role: 'user', content: [{ type: 'text', text: 'do 1' }] },
    },
    {
      type: 'assistant',
      timestamp: '2026-05-31T01:00:01.000Z',
      message: {
        role: 'assistant',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Claude finished the first option.' }],
      },
    },
  ]);
  await writeJsonl(codexPath, [
    {
      timestamp: '2026-05-31T01:01:00.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'continue' }],
      },
    },
    {
      timestamp: '2026-05-31T01:01:01.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Codex landed the continuation.' }],
      },
    },
  ]);

  const claude = register({
    sessionId: 'claude-session',
    source: 'claude',
    project,
    projectName: 'mixed-project',
    transcriptPath: claudePath,
    lastTurnClosed: true,
    lastEventAt: Date.parse('2026-05-31T01:00:01.000Z'),
    lastSnippet: 'Claude finished the first option.',
    knownSize: 0,
    title: 'Claude work',
    firstPrompt: 'do 1',
    lastUserPrompt: 'do 1',
    gitBranch: 'main',
  });
  const codex = register({
    sessionId: 'codex-session',
    source: 'codex',
    project,
    projectName: 'mixed-project',
    transcriptPath: codexPath,
    lastTurnClosed: true,
    lastEventAt: Date.parse('2026-05-31T01:01:01.000Z'),
    lastSnippet: 'Codex landed the continuation.',
    knownSize: 0,
    title: 'Codex work',
    firstPrompt: 'continue',
    lastUserPrompt: 'continue',
    gitBranch: 'main',
  });

  const projects = await buildProjectDigests(
    [claude, codex],
    opts,
    'work',
    Date.parse('2026-05-31T01:02:00.000Z'),
    { sessionN: 2 },
  );

  expect(projects).toHaveLength(1);
  expect(projects[0]!.project).toBe(project);
  expect(projects[0]!.sources).toEqual(['claude', 'codex']);
  expect(projects[0]!.primary?.sessionId).toBe('codex-session');
  expect(projects[0]!.sessions.map((s) => s.sessionId)).toEqual(['codex-session', 'claude-session']);
  expect(projects[0]!.sessions[0]!.title).toBe('Codex work');
  expect(projects[0]!.sessions[0]!.transcriptPath).toBe(codexPath);
  expect(projects[0]!.sessions[0]!.recentTurns[0]!.user.text).toBe('continue');
  expect(projects[0]!.sessions[0]!.recentTurns[0]!.assistantAfter?.text).toBe('Codex landed the continuation.');
  expect(projects[0]!.evidence.sessionCountBySource).toEqual({ claude: 1, codex: 1 });
  expect(projects[0]!.evidence.latestUserPrompt).toBe('continue');
  expect(projects[0]!.evidence.latestAssistantOutcome).toBe('Codex landed the continuation.');
});
