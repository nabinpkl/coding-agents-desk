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

function patchApplyEnd(payload: Record<string, unknown>) {
  return blocks(codexAdapter, {
    timestamp: '2026-07-30T12:00:00.000Z',
    type: 'event_msg',
    payload: { type: 'patch_apply_end', call_id: 'call-1', status: 'completed', ...payload },
  });
}

test('an applied patch names its files instead of dumping the diff', () => {
  const diff = `@@ -1,2 +1,3 @@\n+${'x'.repeat(5_000)}\n`;
  const applied = patchApplyEnd({
    stdout: 'Success. Updated the following files:\nM Sources/WorkspaceShell/FileTab.swift\n',
    stderr: '',
    success: true,
    changes: {
      '/repo/Sources/WorkspaceShell/FileTab.swift': { type: 'update', unified_diff: diff, move_path: null },
    },
  });

  // 3,219 of these across the six largest rollouts here, mean 3,343 characters of
  // payload JSON each and 24% cut mid-diff by the 4,096-character cap.
  expect(applied[0]).toEqual({
    kind: 'metadata',
    label: 'Patch Applied',
    text: '1 file · M FileTab.swift',
  });
  expect(JSON.stringify(applied[0])).not.toContain('xxxx');
  // The whole payload, diff included, is still one press away.
  expect(applied.at(-1)).toEqual({ kind: 'raw', label: 'Raw JSON' });
});

test('a multi-file patch lists every file it touched, then counts the rest', () => {
  // 884 of the 3,219 (27%) touch more than one file, so the list is load-bearing:
  // "did this edit land" is per file, not per patch.
  const changes = (names: string[], type = 'update') =>
    Object.fromEntries(names.map((name) => [`/repo/${name}`, { type }]));

  expect(patchApplyEnd({
    success: true,
    changes: {
      ...changes(['a.swift']),
      ...changes(['b.swift'], 'add'),
      ...changes(['c.swift'], 'delete'),
    },
  })[0]?.text).toBe('3 files · M a.swift, A b.swift, D c.swift');

  // Beyond six named files the row counts the remainder rather than growing
  // unbounded; the largest patch here touches 20.
  const many = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((n) => `${n}.swift`);
  expect(patchApplyEnd({ success: true, changes: changes(many) })[0]?.text)
    .toBe('8 files · M a.swift, M b.swift, M c.swift, M d.swift, M e.swift, M f.swift, +2 more');

  // A change type a future harness release invents is marked unfamiliar rather
  // than being silently dropped from the list.
  expect(patchApplyEnd({ success: true, changes: changes(['a.swift'], 'rewrite') })[0]?.text)
    .toBe('1 file · ? a.swift');
});

test('a failed patch says so and shows what it left behind', () => {
  // Never yet seen: all 3,219 records report success. Written for the same reason
  // the hook-failure branch is -- a patch that did not apply must not read as one
  // that did.
  const failed = patchApplyEnd({
    stdout: '',
    stderr: 'error: patch does not apply to FileTab.swift',
    success: false,
    changes: { '/repo/Sources/WorkspaceShell/FileTab.swift': { type: 'update' } },
  });
  expect(failed[0]).toEqual({
    kind: 'metadata',
    label: 'Patch Failed',
    text: 'error: patch does not apply to FileTab.swift',
  });
  // No file list: nothing landed, so naming the file would describe an edit that
  // did not happen.
  expect(failed[0]?.text).not.toContain('M FileTab.swift');
});

test('a patch carrying no changes map falls back to the harness confirmation', () => {
  // `changes` is present on all 3,219 records here, so this is the branch that keeps
  // a future record shape from rendering a bare label with nothing under it.
  expect(patchApplyEnd({ stdout: 'Success. Updated 1 file.', success: true, changes: {} })[0])
    .toEqual({ kind: 'metadata', label: 'Patch Applied', text: 'Success. Updated 1 file.' });

  // With neither, the payload is still better than an empty row.
  expect(patchApplyEnd({ success: true })[0]?.text).toContain('patch_apply_end');
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
