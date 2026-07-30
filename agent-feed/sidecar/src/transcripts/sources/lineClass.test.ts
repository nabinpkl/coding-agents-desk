import { expect, test } from 'bun:test';
import { claudeAdapter } from './claudeTranscript.ts';
import { codexAdapter } from './codexTranscript.ts';
import type { SourceAdapter } from './transcriptTypes.ts';

// Asserted THROUGH the adapters rather than against the classifier directly.
// The classifier reads the raw record and the adapter renders it, and the bug
// that matters is the two disagreeing -- a line the adapter turns into visible
// prose that the classifier calls machinery would silently vanish from the nice
// view with no way to notice from either side alone.
function classOf(adapter: SourceAdapter, record: unknown): string | undefined {
  return adapter.processLine(JSON.stringify(record))?.lineClass;
}

const claude = (record: unknown) => classOf(claudeAdapter, record);
const codex = (record: unknown) => classOf(codexAdapter, record);

test('prose, reasoning, tool calls and results are content on both harnesses', () => {
  expect(claude({
    type: 'assistant',
    timestamp: '2026-07-29T12:00:00.000Z',
    message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
  })).toBe('content');
  expect(claude({
    type: 'user',
    timestamp: '2026-07-29T12:00:00.000Z',
    message: { role: 'user', content: 'Try again.' },
  })).toBe('content');
  expect(codex({
    type: 'response_item',
    payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }] },
  })).toBe('content');
  expect(codex({
    type: 'response_item',
    payload: { type: 'function_call', name: 'shell', arguments: '{"command":"ls"}' },
  })).toBe('content');
  expect(codex({
    type: 'response_item',
    payload: { type: 'function_call_output', output: 'AGENTS.md' },
  })).toBe('content');
});

test('claude harness state records are machinery', () => {
  for (const type of [
    'mode',
    'permission-mode',
    'ai-title',
    'custom-title',
    'last-prompt',
    'queue-operation',
    'file-history-delta',
    'file-history-snapshot',
    'bridge-session',
    'agent-name',
    'worktree-state',
  ]) {
    expect(claude({ type, timestamp: '2026-07-29T12:00:00.000Z' })).toBe('machinery');
  }
});

test('attachment is split by subtype, not treated as one kind', () => {
  const attachment = (value: Record<string, unknown>) =>
    claude({ type: 'attachment', timestamp: '2026-07-29T12:00:00.000Z', attachment: value });

  for (const type of [
    'task_reminder',
    'hook_additional_context',
    'deferred_tools_delta',
    'agent_listing_delta',
    'mcp_instructions_delta',
    'command_permissions',
    'date_change',
    'skill_listing',
  ]) {
    expect(attachment({ type })).toBe('machinery');
  }

  // 978 diagnostics rows in this project carry real type errors, and they sat
  // indistinguishable among 4,891 hook dumps under one `Attachment` label.
  for (const type of [
    'diagnostics',
    'queued_command',
    'edited_text_file',
    'file',
    'compact_file_reference',
    'structured_output',
    'goal_status',
    'nested_memory',
    'plan_mode',
    'plan_mode_exit',
  ]) {
    expect(attachment({ type })).toBe('content');
  }
});

test('a hook is machinery only when it succeeded', () => {
  const hook = (value: Record<string, unknown>) =>
    claude({ type: 'attachment', timestamp: '2026-07-29T12:00:00.000Z', attachment: value });

  expect(hook({ type: 'async_hook_response', exitCode: 0 })).toBe('machinery');
  expect(hook({ type: 'hook_success', exitCode: 0 })).toBe('machinery');

  // Every hook in this project's history exited 0, so this branch has never
  // rendered. A failing hook is exactly what a viewer has to see, which is why
  // the exit code decides and not the subtype.
  expect(hook({ type: 'async_hook_response', exitCode: 2 })).toBe('content');
  expect(hook({ type: 'hook_failure', exitCode: 1 })).toBe('content');
  expect(hook({ type: 'hook_success' })).toBe('content');
});

test('codex config dumps and superseded occupancy are machinery', () => {
  for (const type of [
    'session_meta',
    'turn_context',
    'world_state',
    'inter_agent_communication_metadata',
  ]) {
    expect(codex({ type, payload: { cwd: '/tmp' } })).toBe('machinery');
  }

  expect(codex({
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: { last_token_usage: { total_tokens: 88_000 }, model_context_window: 258_400 },
    },
  })).toBe('machinery');
});

test('the agent-message notification is machinery, its response-item record is not', () => {
  // One message written twice: 6,934 pairs across the six largest rollouts here, 6,842
  // byte-identical, and where they differ the response_item is a strict superset. The
  // notification renders dim and the record bright, so keeping both showed the same
  // paragraph twice at two weights.
  expect(codex({
    type: 'event_msg',
    payload: { type: 'agent_message', message: 'Fixed and pushed.', phase: 'commentary' },
  })).toBe('machinery');

  // The record itself stays, because it is the one the prose is read from.
  expect(codex({
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'Fixed and pushed.' }],
    },
  })).toBe('content');

  // A DIFFERENT record that happens to share the name: 453 of these against 72,324
  // notifications, and nothing shows it duplicating anything, so it keeps the content
  // default rather than being swept up by the name.
  expect(codex({
    type: 'response_item',
    payload: { type: 'agent_message', message: 'sub-agent finished' },
  })).toBe('content');

  // The user's own message is the same notification/record shape and is deliberately
  // NOT omitted: it has not been measured, and a person's words are the last thing to
  // drop on an unverified hunch.
  expect(codex({
    type: 'event_msg',
    payload: { type: 'user_message', message: 'try again' },
  })).toBe('content');
});

test('reasoning is content when it carries a trace and machinery when encrypted', () => {
  const withText = {
    type: 'response_item',
    payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'Check the parser.' }] },
  };
  const encrypted = {
    type: 'response_item',
    payload: { type: 'reasoning', summary: [], encrypted_content: 'gAAAAABo0000deadbeef' },
  };

  expect(codex(withText)).toBe('content');
  expect(codex(encrypted)).toBe('machinery');

  // The classifier and the renderer share one text scan, so these two assertions
  // cannot come apart: whatever renders as a reasoning block is content, and whatever
  // renders as the named encrypted placeholder is not.
  expect(codexAdapter.processLine(JSON.stringify(withText))?.event?.blocks[0])
    .toEqual({ kind: 'reasoning', text: 'Check the parser.' });
  expect(codexAdapter.processLine(JSON.stringify(encrypted))?.event?.blocks[0])
    .toEqual({ kind: 'metadata', label: 'Reasoning', text: 'encrypted, no readable trace' });
});

test('claude thinking with no readable trace is machinery, with one is content', () => {
  const line = (content: unknown) => ({
    type: 'assistant',
    timestamp: '2026-07-29T12:00:00.000Z',
    message: { role: 'assistant', content },
  });
  const signature = 'EpYFCmMIDxgCKkC66AoVqQV6TP9u7NFrfmlAXgXLlsTAHxuAyApaAvp73N';

  // 587 rows in this project's largest Claude transcript. They render as a Plain
  // card holding the signature blob, which says nothing.
  expect(claude(line([{ type: 'thinking', thinking: '', signature }])))
    .toBe('machinery');
  expect(claude(line([{ type: 'thinking', thinking: 'Check the parser.', signature }])))
    .toBe('content');

  // Anything else riding along makes the line content regardless.
  expect(claude(line([
    { type: 'thinking', thinking: '', signature },
    { type: 'text', text: 'Done.' },
  ]))).toBe('content');
  expect(claude(line([]))).toBe('content');

  // Renderer and classifier share one text scan, so these cannot come apart.
  const blocks = (content: unknown) =>
    claudeAdapter.processLine(JSON.stringify(line(content)))?.event?.blocks[0]?.kind;
  expect(blocks([{ type: 'thinking', thinking: 'Check the parser.', signature }])).toBe('reasoning');
  expect(blocks([{ type: 'thinking', thinking: '', signature }])).toBe('plain');
});

test('an unrecognized record stays visible rather than vanishing', () => {
  // The whole point of the deny-list polarity: a type a future harness release
  // invents must show up as an unfamiliar row, not disappear silently.
  expect(claude({ type: 'some-future-record', timestamp: '2026-07-29T12:00:00.000Z' }))
    .toBe('content');
  expect(claude({
    type: 'attachment',
    timestamp: '2026-07-29T12:00:00.000Z',
    attachment: { type: 'some_future_attachment' },
  })).toBe('content');
  expect(codex({ type: 'some_future_top_level', payload: {} })).toBe('content');
  expect(codex({ type: 'event_msg', payload: { type: 'some_future_event' } })).toBe('content');
});

test('an unparseable line stays visible', () => {
  expect(claudeAdapter.processLine('{not-json')?.lineClass).toBeUndefined();
  expect(codexAdapter.processLine('{not-json')?.lineClass).toBeUndefined();
});
