// Adapter turn-boundary signals. Both adapters translate their own terminal
// markers into the single `turnClosed` field on LineResult; the watcher folds
// it into `session.lastTurnClosed` and digest.computeBin derives the 'live'
// bin from it at read time. These tests pin the per-line contract so a
// harness transcript-format drift is caught at the adapter seam.

import { expect, test } from 'bun:test';
import { claudeAdapter } from './claudeTranscript.ts';
import { codexAdapter } from './codexTranscript.ts';

// --- Claude ---

test('claude user message opens the turn', () => {
  const r = claudeAdapter.processLine(JSON.stringify({
    type: 'user',
    timestamp: '2026-07-16T05:00:00.000Z',
    message: { role: 'user', content: 'do the thing' },
  }));
  expect(r?.turnClosed).toBe(false);
});

test('claude assistant end_turn closes the turn', () => {
  const r = claudeAdapter.processLine(JSON.stringify({
    type: 'assistant',
    timestamp: '2026-07-16T05:00:01.000Z',
    message: {
      role: 'assistant',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'done' }],
    },
  }));
  expect(r?.turnClosed).toBe(true);
});

test('claude mid-turn assistant output (tool_use, no end_turn) keeps the turn open', () => {
  const r = claudeAdapter.processLine(JSON.stringify({
    type: 'assistant',
    timestamp: '2026-07-16T05:00:01.000Z',
    message: {
      role: 'assistant',
      stop_reason: null,
      content: [{ type: 'tool_use', name: 'Bash', id: 't1', input: { command: 'ls' } }],
    },
  }));
  expect(r?.turnClosed).toBe(false);
});

test('claude compaction marker keeps the turn open', () => {
  const r = claudeAdapter.processLine(JSON.stringify({
    type: 'user',
    timestamp: '2026-07-16T05:00:02.000Z',
    isCompactSummary: true,
    message: { role: 'user', content: 'summary of earlier turns' },
  }));
  expect(r?.turnClosed).toBe(false);
});

// --- Codex ---

test('codex task_started opens the turn', () => {
  const r = codexAdapter.processLine(JSON.stringify({
    timestamp: '2026-07-16T05:00:00.000Z',
    type: 'event_msg',
    payload: { type: 'task_started' },
  }));
  expect(r?.turnClosed).toBe(false);
});

test('codex task_complete closes the turn', () => {
  const r = codexAdapter.processLine(JSON.stringify({
    timestamp: '2026-07-16T05:00:10.000Z',
    type: 'event_msg',
    payload: { type: 'task_complete', last_agent_message: 'done' },
  }));
  expect(r?.turnClosed).toBe(true);
});

test('codex turn_aborted closes the turn', () => {
  const r = codexAdapter.processLine(JSON.stringify({
    timestamp: '2026-07-16T05:00:10.000Z',
    type: 'event_msg',
    payload: { type: 'turn_aborted' },
  }));
  expect(r?.turnClosed).toBe(true);
});

test('codex response_item lines carry no turn signal', () => {
  const r = codexAdapter.processLine(JSON.stringify({
    timestamp: '2026-07-16T05:00:05.000Z',
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'working on it' }],
    },
  }));
  expect(r?.turnClosed).toBeUndefined();
});
