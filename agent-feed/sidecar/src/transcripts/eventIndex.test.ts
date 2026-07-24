import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getEventCount, readEventRaw, readEvents } from './eventIndex.ts';
import { state } from './transcriptState.ts';
import type { Session } from './sources/transcriptTypes.ts';
import { runSafetyScan } from './transcriptWatcher.ts';

afterEach(async () => {
  const closes = [...state.tailWatchers.values()].map((entry) => {
    if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
    return entry.watcher.close();
  });
  await Promise.all(closes);
  state.tailWatchers.clear();
  state.sessions.clear();
  state.eventByteOffsets.clear();
  state.indexed.clear();
  state.indexBuilds.clear();
});

async function writeJsonl(file: string, rows: unknown[]): Promise<void> {
  await Bun.write(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
}

function register(session: Session): void {
  state.sessions.set(session.sessionId, session);
}

function codexMessage(text: string, i: number): unknown {
  return {
    timestamp: new Date(Date.UTC(2026, 5, 30, 8, 0, i)).toISOString(),
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text }],
    },
  };
}

test('event pagination uses byte offsets for transcripts with multibyte text', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-feed-events-'));
  const transcriptPath = join(dir, 'codex.jsonl');
  const rows: unknown[] = [];
  for (let i = 0; i < 149; i++) {
    rows.push(codexMessage(`prefix ${i} Claude’s rendered UI exists visually — `.repeat(40), i));
  }
  rows.push(codexMessage('FINAL-SENTINEL', 149));
  await writeJsonl(transcriptPath, rows);

  register({
    sessionId: 'codex-byte-offset-test',
    source: 'codex',
    project: dir,
    projectName: 'project',
    transcriptPath,
    lastTurnClosed: true,
    lastEventAt: 0,
    lastSnippet: '',
    knownSize: 0,
  });

  const events = await readEvents('codex-byte-offset-test', transcriptPath, 50, 100);

  expect(events).toHaveLength(100);
  expect(events[0]!.index).toBe(50);
  expect(events.at(-1)!.index).toBe(149);
  expect(events.at(-1)!.blocks[0]!.text).toBe('FINAL-SENTINEL');
});

test('every nonempty JSONL line is indexed and its exact raw bytes are readable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-feed-events-complete-'));
  const transcriptPath = join(dir, 'codex.jsonl');
  const lines = [
    JSON.stringify({ type: 'session_meta', payload: { id: 's1', cwd: dir } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } }),
    JSON.stringify({ type: 'future_record', payload: { visible: 'é🙂' } }),
    '{malformed-json',
  ];
  await Bun.write(transcriptPath, `${lines.join('\n')}\n`);

  register({
    sessionId: 'codex-complete-index-test',
    source: 'codex',
    project: dir,
    projectName: 'project',
    transcriptPath,
    lastTurnClosed: true,
    lastEventAt: 0,
    lastSnippet: '',
    knownSize: 0,
  });

  const events = await readEvents('codex-complete-index-test', transcriptPath, 0, 10);
  expect(events).toHaveLength(lines.length);
  expect(events.map((event) => event.index)).toEqual([0, 1, 2, 3]);
  expect(await readEventRaw('codex-complete-index-test', 2)).toBe(lines[2]!);
  expect(await readEventRaw('codex-complete-index-test', 3)).toBe(lines[3]!);
});

test('safety scan rebuilds a stale event index after a missed transcript truncation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-feed-events-truncated-'));
  const transcriptPath = join(dir, 'codex.jsonl');
  const originalRows = [
    codexMessage('first original event', 0),
    codexMessage('second original event', 1),
    codexMessage('third original event that makes the file longer', 2),
  ];
  await writeJsonl(transcriptPath, originalRows);

  const session: Session = {
    sessionId: 'codex-truncated-index-test',
    source: 'codex',
    project: dir,
    projectName: 'project',
    transcriptPath,
    lastTurnClosed: true,
    lastEventAt: 0,
    lastSnippet: '',
    knownSize: 0,
  };
  register(session);

  expect(await readEvents(session.sessionId, transcriptPath, 0, 10)).toHaveLength(3);
  expect(getEventCount(session.sessionId)).toBe(3);
  session.knownSize = (await stat(transcriptPath)).size;

  const rewrittenLines = [
    JSON.stringify(codexMessage('first rewritten event', 3)),
    JSON.stringify(codexMessage('second rewritten event', 4)),
  ];
  await Bun.write(transcriptPath, `${rewrittenLines.join('\n')}\n`);

  await runSafetyScan();

  expect(session.knownSize).toBe((await stat(transcriptPath)).size);
  expect(await readEvents(session.sessionId, transcriptPath, 0, 10)).toHaveLength(2);
  expect(getEventCount(session.sessionId)).toBe(2);
  expect(await readEventRaw(session.sessionId, 1)).toBe(rewrittenLines[1]!);
});
