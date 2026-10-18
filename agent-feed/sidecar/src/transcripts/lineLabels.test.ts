import { expect, test } from 'bun:test';
import { claudeAdapter } from "@/transcripts/claude/claudeTranscript";
import { codexAdapter } from "@/transcripts/codex/codexTranscript";

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

test('a prompt a person sent mid-turn reads as their message; the CLI\'s own notifications do not', () => {
  // The CLI folds a message sent while a turn runs into that turn and writes only this attachment,
  // never a `user` record, so as a "Queued Command" row the person's own words were not in the feed.
  const event = (attachment: Record<string, unknown>) => claudeAdapter.processLine(JSON.stringify({
    type: 'attachment',
    timestamp: '2026-10-18T06:35:36.924Z',
    attachment,
  }))?.event;
  const person = event({ type: 'queued_command', prompt: 'also show queued messages', commandMode: 'prompt', origin: { kind: 'human' } });
  expect(person?.type).toBe('user');
  expect(person?.humanTurn).toBe(true);
  expect(person?.blocks[0]).toMatchObject({ kind: 'text', text: 'also show queued messages' });
  const notification = event({
    type: 'queued_command',
    prompt: '<task-notification>done</task-notification>',
    commandMode: 'task-notification',
    origin: { kind: 'task-notification' },
  });
  expect(notification?.type).toBe('system');
  expect(notification?.blocks[0]?.label).toBe('Queued Command');
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

test('a call that hands over files is labelled with the files, not the delivery mode', () => {
  const toolBlock = (name: string, input: Record<string, unknown>) =>
    blocks(claudeAdapter, {
      type: 'assistant',
      timestamp: '2026-07-29T12:00:00.000Z',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call-1', name, input }],
      },
    })[0];

  // `status` is the only bare string on a SendUserFile, so the any-string fallback used to make
  // every one of these read `SendUserFile normal`.
  expect(toolBlock('SendUserFile', {
    files: ['/tmp/s/edges-9-focus-wire.png', '/tmp/s/edges-5-folders.png'],
    caption: 'One file at a time instead of all of them',
    status: 'normal',
  })?.summary).toBe('SendUserFile edges-9-focus-wire.png, edges-5-folders.png');

  // A description still wins: it says why, and the names are on the call's own rows.
  expect(toolBlock('SomeFutureTool', { description: 'Why this ran', files: ['/tmp/a.png'] })?.summary)
    .toBe('SomeFutureTool Why this ran');
  // Nothing usable in the list leaves the tool named rather than labelled with punctuation.
  expect(toolBlock('SendUserFile', { files: [], status: 'normal' })?.summary)
    .toBe('SendUserFile normal');
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

function customToolCall(name: string, input: string) {
  return blocks(codexAdapter, {
    timestamp: '2026-07-30T12:00:00.000Z',
    type: 'response_item',
    payload: {
      type: 'custom_tool_call',
      id: 'ctc_1',
      status: 'completed',
      call_id: 'call_XGkI1GjICR7m4HFnHRcLarCo',
      name,
      input,
    },
  })[0];
}

test('a tool result that is only a screenshot is counted, not dropped', () => {
  // `joinTextContent` skips input_image because its payload is a data: URI several
  // hundred KB wide. 1,007 outputs here carry one and 444 carry nothing else, so
  // those rows disappeared entirely.
  const dataUri = `data:image/png;base64,${'A'.repeat(4_000)}`;
  const imageOnly = blocks(codexAdapter, {
    timestamp: '2026-07-30T12:00:00.000Z',
    type: 'response_item',
    payload: {
      type: 'function_call_output',
      call_id: 'call_1',
      output: [{ type: 'input_image', image_url: dataUri, detail: 'original' }],
    },
  });
  expect(imageOnly[0]).toMatchObject({ kind: 'tool_result', callId: 'call_1' });
  expect(JSON.stringify(imageOnly[0])).toContain('[1 image]');
  expect(JSON.stringify(imageOnly[0])).not.toContain('AAAA');

  // Alongside text the note follows it rather than replacing it.
  const withText = blocks(codexAdapter, {
    timestamp: '2026-07-30T12:00:00.000Z',
    type: 'response_item',
    payload: {
      type: 'function_call_output',
      call_id: 'call_2',
      output: [
        { type: 'input_text', text: 'Wall time: 1.9 seconds' },
        { type: 'input_image', image_url: dataUri, detail: 'original' },
      ],
    },
  });
  expect(JSON.stringify(withText[0])).toContain('Wall time: 1.9 seconds');
  expect(JSON.stringify(withText[0])).toContain('[1 image]');
});

function functionCall(name: string, args: Record<string, unknown>) {
  return blocks(codexAdapter, {
    timestamp: '2026-07-30T12:00:00.000Z',
    type: 'response_item',
    payload: {
      type: 'function_call',
      id: 'fc_1',
      call_id: 'call_1',
      name,
      arguments: JSON.stringify(args),
    },
  })[0];
}

test('a function call whose arguments do not lead with a string still names itself', () => {
  // The generic rule read `input[firstKey]` and required a string, so a numeric or
  // array first argument fell to the bare tool name -- 11,951 rows here, 9,700 of
  // them write_stdin, every one with its arguments sitting right there unread.
  expect(functionCall('write_stdin', { session_id: 24659, chars: '', yield_time_ms: 1000 })?.summary)
    .toBe('session 24659  (poll)');
  expect(functionCall('write_stdin', { session_id: 24659, chars: 'just check\n' })?.summary)
    .toBe('session 24659  just check');

  expect(functionCall('update_plan', {
    plan: [{ step: 'Map the wiring', status: 'completed' }, { step: 'Add a failing test', status: 'in_progress' }],
  })?.summary).toBe('2 steps · Map the wiring');

  expect(functionCall('wait_agent', { targets: ['019f4a6a-c76d', '019f4a6a-cc16'] })?.summary)
    .toBe('2 agents');

  // The only argument here is a number, and it is the entire content of the row.
  // The generic reader keeps the tool name in front of a bare value, which is
  // the convention the Claude adapter follows too.
  expect(functionCall('wait', { session_id: 562 })?.summary).toBe('wait 562');

  // A tool that genuinely takes no arguments keeps its name and nothing else.
  expect(functionCall('list_agents', {})?.summary).toBe('list_agents');
});

test('a summary that says what the call did does not repeat the chip beside it', () => {
  // Every tool row shows the tool name in a chip, so a summary that opens with it
  // reads "exec exec". Where a rule produced the detail the name adds nothing.
  const startsWithItsChip = (block: { tool?: string; summary?: string } | undefined) =>
    (block?.summary ?? '').startsWith(block?.tool ?? '');
  expect(startsWithItsChip(functionCall('write_stdin', { session_id: 24659, chars: '' }))).toBe(false);
  expect(startsWithItsChip(customToolCall('exec', 'const r = await tools.exec_command({cmd:"ls"})'))).toBe(false);
  expect(startsWithItsChip(customToolCall('apply_patch', '*** Begin Patch\n*** Add File: /repo/a.swift\n*** End Patch'))).toBe(false);
});

test('a command that spans lines says how much of it is not shown', () => {
  // The collapsed preview cuts at the first newline, so a heredoc read as
  // `python - <<'PY'` with no sign that 30 lines of script followed. 3,252
  // commands here span more than one line.
  expect(functionCall('exec_command', {
    cmd: "python - <<'PY'\nfrom pathlib import Path\nprint(Path.cwd())\nPY",
    workdir: '/repo',
  })?.summary).toBe("python - <<'PY'  (+3 more lines)");

  // A single-line command is unchanged, and keeps the full 200-character budget.
  expect(functionCall('exec_command', { cmd: 'git status --short', workdir: '/repo' })?.summary)
    .toBe('git status --short');
  const long = 'rg -n '.concat("'needle|'".repeat(60));
  expect(functionCall('exec_command', { cmd: long })?.summary).toBe(long.slice(0, 200));
});

test('the hand-written codex tool rules are unchanged', () => {
  expect(functionCall('apply_patch', { file_path: '/repo/Sources/FileTab.swift' })?.summary)
    .toBe('apply_patch FileTab.swift');
  expect(functionCall('read_file', { path: '/repo/Sources/FileTab.swift' })?.summary)
    .toBe('read_file FileTab.swift');
  expect(functionCall('shell', { command: 'ls -la' })?.summary).toBe('ls -la');
  // An unfamiliar tool is still named by its first argument.
  expect(functionCall('some_future_tool', { query: 'what changed' })?.summary)
    .toBe('some_future_tool what changed');
});
