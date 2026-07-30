import { expect, test } from 'bun:test';
import { claudeAdapter } from './claudeTranscript.ts';
import { codexAdapter } from './codexTranscript.ts';

function blocks(adapter: typeof claudeAdapter | typeof codexAdapter, record: unknown) {
  return adapter.processLine(JSON.stringify(record))?.event?.blocks ?? [];
}

function claudeAttachment(attachment: Record<string, unknown>) {
  return blocks(claudeAdapter, {
    type: 'attachment',
    timestamp: '2026-07-29T12:00:00.000Z',
    attachment,
  })[0];
}

test('attachment rows are labelled by subtype, not all "Attachment"', () => {
  // 978 diagnostics rows in this project sat indistinguishable among 4,891 rows of
  // hook telemetry under one label, so the type errors they carry were unfindable.
  expect(claudeAttachment({ type: 'diagnostics', diagnostics: [] })?.label)
    .toBe('Diagnostics');
  expect(claudeAttachment({ type: 'hook_success', exitCode: 0 })?.label).toBe('Hook');
  expect(claudeAttachment({ type: 'hook_failure', exitCode: 2 })?.label)
    .toBe('Hook Failed');
  expect(claudeAttachment({ type: 'queued_command' })?.label).toBe('Queued Command');
});

test('an unmapped attachment subtype keeps the subtype rather than going generic', () => {
  // A name we have not seen is still more use than none, and it should read as
  // unfamiliar rather than as the same thing as everything else.
  expect(claudeAttachment({ type: 'some_future_attachment' })?.label)
    .toBe('Attachment: some_future_attachment');
  expect(claudeAttachment({})?.label).toBe('Attachment');
});

test('every claude tool call gets a label, not just the six with a rule', () => {
  const toolBlock = (name: string, input: Record<string, unknown>) =>
    blocks(claudeAdapter, {
      type: 'assistant',
      timestamp: '2026-07-29T12:00:00.000Z',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call-1', name, input }],
      },
    })[0];

  // Blank before this: `summarizeToolUse` returned '' for anything but
  // Read/Edit/Write/Bash/Grep/Glob, so 42 Skill and 139 Agent calls in this project
  // rendered with an empty chip. The Codex adapter always had a fallback.
  expect(toolBlock('Skill', { skill: 'codebase-onboarding' })?.summary)
    .toBe('Skill codebase-onboarding');
  expect(toolBlock('Agent', { description: 'Audit the wire types', subagent_type: 'Explore' })?.summary)
    .toBe('Agent Audit the wire types');
  expect(toolBlock('WebFetch', { url: 'https://example.com/a' })?.summary)
    .toBe('WebFetch https://example.com/a');
  expect(toolBlock('ToolSearch', { query: 'select:Read' })?.summary)
    .toBe('ToolSearch select:Read');
  // Any string input beats a blank chip, and a tool with none keeps its name.
  expect(toolBlock('SomeFutureTool', { unexpectedKey: 'value' })?.summary)
    .toBe('SomeFutureTool value');
  expect(toolBlock('SomeFutureTool', { count: 3 })?.summary).toBe('SomeFutureTool');

  // The hand-written rules still win, so the existing labels do not change shape.
  expect(toolBlock('Read', { file_path: '/repo/src/main.ts' })?.summary)
    .toBe('Read main.ts');
  expect(toolBlock('Bash', { command: 'ls -la' })?.summary).toBe('ls -la');
});

test('encrypted codex reasoning is named rather than dumped as ciphertext', () => {
  const ciphertext = `gAAAAABo${'A'.repeat(3_000)}`;
  const encrypted = blocks(codexAdapter, {
    timestamp: '2026-07-29T12:00:00.000Z',
    type: 'response_item',
    payload: { type: 'reasoning', summary: [], encrypted_content: ciphertext },
  });

  // 81,905 of these across this project's rollouts, several KB of base64 each. The
  // exact line is still one drawer away.
  expect(encrypted[0]).toEqual({
    kind: 'metadata',
    label: 'Reasoning',
    text: 'encrypted, no readable trace',
  });
  expect(JSON.stringify(encrypted[0])).not.toContain(ciphertext.slice(0, 40));
  expect(encrypted.at(-1)).toEqual({ kind: 'raw', label: 'Raw JSON' });

  // A trace that IS readable still renders as reasoning.
  expect(blocks(codexAdapter, {
    timestamp: '2026-07-29T12:00:00.000Z',
    type: 'response_item',
    payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'Check the parser.' }] },
  })[0]).toEqual({ kind: 'reasoning', text: 'Check the parser.' });
});
