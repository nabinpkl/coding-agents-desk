import { expect, test } from 'bun:test';
import { claudeAdapter } from "@/transcripts/sources/claudeTranscript";
import { codexAdapter } from "@/transcripts/sources/codexTranscript";
import { PLAIN_PREVIEW_MAX_BYTES } from "@/transcripts/sources/plainActivity";
import type { LineResult } from "@/transcripts/sources/transcriptTypes";

function visible(result: LineResult | null): NonNullable<LineResult['event']> {
  expect(result).not.toBeNull();
  expect(result?.event).toBeDefined();
  return result!.event!;
}

function expectRawLast(result: LineResult | null): NonNullable<LineResult['event']> {
  const event = visible(result);
  expect(event.blocks.at(-1)).toEqual({ kind: 'raw', label: 'Raw JSON' });
  return event;
}

test('claude thinking becomes a reasoning event and keeps raw access', () => {
  const event = expectRawLast(claudeAdapter.processLine(JSON.stringify({
    type: 'assistant',
    timestamp: '2026-07-18T12:00:00.000Z',
    message: {
      role: 'assistant',
      content: [{ type: 'thinking', thinking: 'Inspect the parser first.', signature: 'opaque' }],
    },
  })));

  expect(event.type).toBe('reasoning');
  expect(event.blocks[0]).toEqual({ kind: 'reasoning', text: 'Inspect the parser first.' });
});

test('claude state records are visible while retaining their state update', () => {
  const result = claudeAdapter.processLine(JSON.stringify({
    type: 'ai-title',
    timestamp: '2026-07-18T12:00:00.000Z',
    aiTitle: 'Parser visibility',
    cwd: '/Users/dev/projects/chatbot',
  }));
  const event = expectRawLast(result);

  expect(result?.title).toBe('Parser visibility');
  expect(result?.cwd).toBe('/Users/dev/projects/chatbot');
  expect(event.type).toBe('system');
  expect(event.blocks.slice(0, -1)).toEqual([
    { kind: 'metadata', label: 'Title', text: 'Parser visibility' },
    { kind: 'metadata', label: 'Working Directory', text: '/Users/dev/projects/chatbot' },
  ]);
});

test('claude unknown and invalid records become Plain rather than disappearing', () => {
  const unknown = expectRawLast(claudeAdapter.processLine(JSON.stringify({
    type: 'future-record',
    payload: { answer: 42 },
  })));
  expect(unknown.type).toBe('system');
  expect(unknown.blocks[0]?.kind).toBe('plain');
  expect(unknown.blocks[0]?.text).toContain('future-record');

  const invalid = expectRawLast(claudeAdapter.processLine('{not-json'));
  expect(invalid.type).toBe('system');
  expect(invalid.blocks[0]).toMatchObject({ kind: 'plain', label: 'Plain' });
  expect(invalid.blocks[0]?.text).toContain('{not-json');
});

test('Plain previews announce truncation at the 64 KiB UTF-8 cap', () => {
  const event = expectRawLast(claudeAdapter.processLine(JSON.stringify({
    type: 'future-record',
    payload: 'x'.repeat(PLAIN_PREVIEW_MAX_BYTES + 100),
  })));
  expect(event.blocks[0]?.kind).toBe('plain');
  expect(event.blocks[0]?.text).toContain('UTF-8 bytes omitted; open Raw JSON');
});

test('claude unknown content blocks become Plain without changing block order', () => {
  const event = expectRawLast(claudeAdapter.processLine(JSON.stringify({
    type: 'assistant',
    timestamp: '2026-07-18T12:00:00.000Z',
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: 'before' },
        { type: 'future-content', value: 'visible' },
        { type: 'text', text: 'after' },
      ],
    },
  })));

  expect(event.blocks.slice(0, -1).map((block) => block.kind)).toEqual(['text', 'plain', 'text']);
  expect(event.blocks[1]?.text).toContain('future-content');
});

test('claude compact boundaries and empty content remain visible', () => {
  const compacted = expectRawLast(claudeAdapter.processLine(JSON.stringify({
    type: 'system',
    subtype: 'compact_boundary',
    content: 'Conversation compacted',
  })));
  expect(compacted.blocks[0]).toEqual({ kind: 'compaction' });

  const empty = expectRawLast(claudeAdapter.processLine(JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [] },
  })));
  expect(empty.blocks[0]).toMatchObject({ kind: 'plain', label: 'Plain' });
});

test('codex state records are visible while retaining lifecycle and usage updates', () => {
  const started = codexAdapter.processLine(JSON.stringify({
    timestamp: '2026-07-18T12:00:00.000Z',
    type: 'event_msg',
    payload: { type: 'task_started', turn_id: 'turn-1' },
  }));
  const startEvent = expectRawLast(started);
  expect(started?.turnClosed).toBe(false);
  expect(startEvent.type).toBe('system');
  expect(startEvent.blocks[0]).toMatchObject({ kind: 'metadata', label: 'Task Started' });

  const counted = codexAdapter.processLine(JSON.stringify({
    timestamp: '2026-07-18T12:00:01.000Z',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: { last_token_usage: { total_tokens: 1234 }, model_context_window: 200000 },
    },
  }));
  const countEvent = expectRawLast(counted);
  expect(counted?.usage).toEqual({ current: 1234, limit: 200000, updatedAt: Date.parse('2026-07-18T12:00:01.000Z') });
  expect(countEvent.blocks[0]).toEqual({ kind: 'metadata', label: 'Token Usage', text: '1,234 / 200,000 tokens' });
});

test('codex metadata and unsupported content records are always visible', () => {
  const metadata = expectRawLast(codexAdapter.processLine(JSON.stringify({
    timestamp: '2026-07-18T12:00:00.000Z',
    type: 'session_meta',
    payload: { id: 'session-1', cwd: '/repo' },
  })));
  expect(metadata.blocks[0]).toMatchObject({ kind: 'metadata', label: 'Session Metadata' });

  const unknown = expectRawLast(codexAdapter.processLine(JSON.stringify({
    timestamp: '2026-07-18T12:00:00.000Z',
    type: 'response_item',
    payload: { type: 'future_item', content: 'visible' },
  })));
  expect(unknown.blocks[0]).toMatchObject({ kind: 'plain', label: 'Plain' });
  expect(unknown.blocks[0]?.text).toContain('future_item');

  const developer = expectRawLast(codexAdapter.processLine(JSON.stringify({
    timestamp: '2026-07-18T12:00:00.000Z',
    type: 'response_item',
    payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'setup' }] },
  })));
  expect(developer.blocks[0]).toEqual({ kind: 'metadata', label: 'Developer Message', text: 'setup' });

  const mixedDeveloper = expectRawLast(codexAdapter.processLine(JSON.stringify({
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'developer',
      content: [
        { type: 'input_text', text: 'known setup' },
        { type: 'future-setup', value: true },
      ],
    },
  })));
  expect(mixedDeveloper.blocks.slice(0, -1).map((block) => block.kind)).toEqual(['metadata', 'plain']);
});

test('codex event reasoning and repeated compaction signals keep their semantic blocks', () => {
  const reasoning = expectRawLast(codexAdapter.processLine(JSON.stringify({
    timestamp: '2026-07-18T12:00:00.000Z',
    type: 'event_msg',
    payload: { type: 'agent_reasoning', text: '**Inspecting the parser**' },
  })));
  expect(reasoning.type).toBe('reasoning');
  expect(reasoning.blocks[0]).toEqual({ kind: 'reasoning', text: '**Inspecting the parser**' });

  const compacted = expectRawLast(codexAdapter.processLine(JSON.stringify({
    timestamp: '2026-07-18T12:00:01.000Z',
    type: 'event_msg',
    payload: { type: 'context_compacted' },
  })));
  expect(compacted.type).toBe('system');
  expect(compacted.blocks[0]).toEqual({ kind: 'compaction' });
});

test('codex invalid records become Plain and encrypted reasoning is named', () => {
  const invalid = expectRawLast(codexAdapter.processLine('not json'));
  expect(invalid.blocks[0]).toMatchObject({ kind: 'plain', label: 'Plain' });

  const encrypted = expectRawLast(codexAdapter.processLine(JSON.stringify({
    timestamp: '2026-07-18T12:00:00.000Z',
    type: 'response_item',
    payload: { type: 'reasoning', encrypted_content: 'opaque' },
  })));
  // Named, not dumped: these hold several KB of base64 each and 81,905 of them
  // exist across this project's rollouts. The Raw drawer still has the exact line,
  // which is what the trailing raw block asserted above is for.
  expect(encrypted.blocks[0]).toEqual({
    kind: 'metadata',
    label: 'Reasoning',
    text: 'encrypted, no readable trace',
  });
  expect(encrypted.blocks[0]?.text).not.toContain('opaque');

  const unsupportedRole = expectRawLast(codexAdapter.processLine(JSON.stringify({
    timestamp: 'invalid',
    type: 'response_item',
    payload: { type: 'message', role: 'future-role', content: [] },
  })));
  expect(unsupportedRole.ts).toBe(0);
  expect(unsupportedRole.blocks[0]).toMatchObject({ kind: 'plain', label: 'Plain' });
});

test('mixed Codex block raw extraction uses the same normalized block indexes', async () => {
  const line = JSON.stringify({
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'assistant',
      content: [
        { type: 'output_text', text: 'before' },
        { type: 'future-content', value: 'visible' },
        { type: 'output_text', text: 'after' },
      ],
    },
  });
  const event = expectRawLast(codexAdapter.processLine(line));
  const extract = codexAdapter.extractBlockRaw;
  expect(extract).toBeDefined();
  if (!extract) return;
  expect(event.blocks.slice(0, -1).map((block) => block.kind)).toEqual(['text', 'plain', 'text']);
  expect(await extract(line, 0)).toBe('before');
  expect(await extract(line, 1)).toContain('future-content');
  expect(await extract(line, 2)).toBe('after');
});

test('codex custom tool records use the existing tool block semantics', () => {
  const call = expectRawLast(codexAdapter.processLine(JSON.stringify({
    timestamp: '2026-07-18T12:00:00.000Z',
    type: 'response_item',
    payload: { type: 'custom_tool_call', name: 'imagegen', call_id: 'call-1', input: '{"prompt":"cat"}' },
  })));
  expect(call.blocks[0]).toMatchObject({ kind: 'tool_use', tool: 'imagegen', callId: 'call-1' });

  const output = expectRawLast(codexAdapter.processLine(JSON.stringify({
    timestamp: '2026-07-18T12:00:01.000Z',
    type: 'response_item',
    payload: { type: 'custom_tool_call_output', call_id: 'call-1', output: 'generated' },
  })));
  expect(output.blocks[0]).toMatchObject({ kind: 'tool_result', callId: 'call-1', preview: 'generated' });
});
