// What the session list is allowed to learn from a transcript, and what it is
// not.
//
// Everything a session row renders comes from these two bounded reads: Claude's
// `readHeader` (32 KB from each end) and Codex's `readTail`. Listing a project
// must never read a transcript body, so these tests pin both the facts the
// windows yield AND the fact that content outside them is invisible -- the
// second half is the guarantee, and it is the one a well-meaning "just scan a
// bit further" change would quietly remove.
//
// One fact is deliberately outside that guarantee, and the tests below say so:
// `cwd`. It is the session's IDENTITY rather than something a row displays -- a
// session with no `cwd` is not listed at all -- and a resumed transcript can open
// with enough `file-history-snapshot` records to push it past the head window.
// So `cwd`, and only `cwd`, is looked for forward of the window when the window
// has none. Titles and prompts stay bounded.

import { expect, test } from 'bun:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { claudeAdapter } from "@/transcripts/claude/claudeTranscript";
import { codexAdapter } from "@/transcripts/codex/codexTranscript";

const CWD = '/tmp/bounded-read-project';

async function transcript(name: string, lines: string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agent-feed-bounded-'));
  const path = join(root, name);
  await writeFile(path, lines.map((line) => `${line}\n`).join(''));
  return path;
}

/** A line that carries nothing the reads care about, sized to push bytes. */
function filler(bytes = 1024): string {
  return JSON.stringify({ type: 'system', pad: 'x'.repeat(bytes) });
}

/** Enough filler to put a gap between the two 32 KB windows. */
const GAP = Array.from({ length: 100 }, () => filler());

const userLine = (text: string) =>
  JSON.stringify({ type: 'user', cwd: CWD, message: { role: 'user', content: text } });

// --- Claude: which directory the session belongs to ---

/** Four of these and a resumed session's opening `cwd` is past the head window. */
const SNAPSHOT = JSON.stringify({
  type: 'file-history-snapshot',
  pad: 'x'.repeat(15 * 1024),
});

test('the opening cwd is found past the head window rather than taken from the tail', async () => {
  const path = await transcript('c.jsonl', [
    JSON.stringify({ type: 'custom-title', customTitle: 'Resumed' }),
    SNAPSHOT,
    SNAPSHOT,
    SNAPSHOT,
    userLine('opening prompt'),
    ...GAP,
    JSON.stringify({ type: 'assistant', cwd: `${CWD}/packages/web` }),
  ]);
  const header = await claudeAdapter.readHeader(path);
  // The tail's `cwd` is wherever the agent's shell wandered to. Taking it filed a live session
  // under one of its own subfolders, and a Bot -- which holds only sessions in its own checkout
  // -- then showed that row as missing while the session was working.
  expect(header?.cwd).toBe(CWD);
  expect(header?.recentCwd).toBe(`${CWD}/packages/web`);
});

test('a session still resolves while its last record is larger than the tail window', async () => {
  const path = await transcript('c.jsonl', [
    SNAPSHOT,
    SNAPSHOT,
    SNAPSHOT,
    userLine('opening prompt'),
    ...GAP,
    // One record filling the whole tail window: the line is cut at both ends, nothing in that
    // window parses, and the header used to come back null. Replaying one 14 MB transcript at
    // each of its own 4770 write boundaries, 111 landed here and another 786 answered with a
    // subdirectory the agent had cd'd into -- so at 19% of the moments the panel re-read that
    // session, its row was missing or filed under a project that does not exist.
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'y'.repeat(40 * 1024) } }),
  ]);
  expect((await claudeAdapter.readHeader(path))?.cwd).toBe(CWD);
});

// --- Claude: titles ---

test('a title written at the end of a long session is still found', async () => {
  const path = await transcript('c.jsonl', [
    userLine('opening prompt'),
    ...GAP,
    JSON.stringify({ type: 'ai-title', aiTitle: 'Refactor the catalog' }),
  ]);
  expect((await claudeAdapter.readHeader(path))?.title).toBe('Refactor the catalog');
});

// Rank, not file order. The harness re-emits its generated title as a session goes
// on, so in a real transcript the user's own name is routinely followed by a
// generated one -- last-write-wins renamed their session back for them.
test('a user-set title outranks the generated one, whichever was written last', async () => {
  const ai = JSON.stringify({ type: 'ai-title', aiTitle: 'Generated' });
  const custom = JSON.stringify({ type: 'custom-title', customTitle: 'What I called it' });
  for (const order of [[ai, custom], [custom, ai]]) {
    const path = await transcript('c.jsonl', [userLine('opening prompt'), ...order]);
    expect((await claudeAdapter.readHeader(path))?.title).toBe('What I called it');
  }
});

// The honest cost of a bounded read, pinned so it is a decision and not a
// surprise: a title reachable only from the middle of a long transcript is not
// found. Measured at 113 of 119 real transcripts carrying their title inside the
// windows, and widening to 64 KB recovered exactly one more.
test('a title only in the middle of a long session is out of reach', async () => {
  const path = await transcript('c.jsonl', [
    userLine('opening prompt'),
    ...GAP.slice(0, 50),
    JSON.stringify({ type: 'ai-title', aiTitle: 'Unreachable' }),
    ...GAP.slice(0, 50),
    JSON.stringify({ type: 'system', note: 'the end' }),
  ]);
  const header = await claudeAdapter.readHeader(path);
  expect(header?.title).toBeUndefined();
  expect(header?.firstPrompt).toBe('opening prompt');
});

// --- Claude: the prompt fallback ---

test('a titleless session falls back to its opening prompt', async () => {
  const path = await transcript('c.jsonl', [userLine('fix the flaky test'), ...GAP]);
  const header = await claudeAdapter.readHeader(path);
  expect(header?.title).toBeUndefined();
  expect(header?.firstPrompt).toBe('fix the flaky test');
});

test('block-array content yields its first text block', async () => {
  const path = await transcript('c.jsonl', [
    JSON.stringify({
      type: 'user',
      cwd: CWD,
      message: { role: 'user', content: [{ type: 'text', text: 'block prompt' }] },
    }),
  ]);
  expect((await claudeAdapter.readHeader(path))?.firstPrompt).toBe('block prompt');
});

// The case that sent three real sessions to the fallback-of-the-fallback: a
// queued command writes no `user` record at all near the head of the file.
test('a queued command is a prompt even with no user record', async () => {
  const path = await transcript('c.jsonl', [
    JSON.stringify({
      type: 'queue-operation',
      operation: 'enqueue',
      cwd: CWD,
      content: 'Review this change for security vulnerabilities.',
    }),
    ...GAP,
  ]);
  expect((await claudeAdapter.readHeader(path))?.firstPrompt)
    .toBe('Review this change for security vulnerabilities.');
});

// Three real sessions in this repo: `/security-review` enqueues a file list on one
// line, and that line is bigger than the whole head window, so nothing in the window
// parses and the row would otherwise render as a UUID.
test('a first record too large for the window still yields its prompt', async () => {
  const path = await transcript('c.jsonl', [
    JSON.stringify({
      type: 'queue-operation',
      operation: 'enqueue',
      cwd: CWD,
      content: `Review this change for security vulnerabilities. ${'/some/path.ts '.repeat(5000)}`,
    }),
    // The cwd the header needs comes from the tail, as it does for these sessions.
    JSON.stringify({ type: 'user', cwd: CWD, message: { role: 'user', content: 'later' } }),
  ]);
  const prompt = (await claudeAdapter.readHeader(path))?.firstPrompt ?? '';
  expect(prompt.startsWith('Review this change for security vulnerabilities.')).toBeTrue();
  // Bounded even though the record is not: only the front of it is ever wanted.
  expect(prompt.length).toBeLessThan(500);
});

test('an oversized record with no prompt in it yields nothing rather than junk', async () => {
  const path = await transcript('c.jsonl', [
    JSON.stringify({ type: 'assistant', cwd: CWD, pad: 'z'.repeat(70000) }),
    JSON.stringify({ type: 'user', cwd: CWD, message: { role: 'user', content: 'later' } }),
  ]);
  expect((await claudeAdapter.readHeader(path))?.firstPrompt).toBeUndefined();
});

test('a dequeue is not a prompt', async () => {
  const path = await transcript('c.jsonl', [
    JSON.stringify({ type: 'user', cwd: CWD, message: { role: 'user', content: '' } }),
    JSON.stringify({ type: 'queue-operation', operation: 'dequeue', content: 'not this' }),
  ]);
  expect((await claudeAdapter.readHeader(path))?.firstPrompt).toBeUndefined();
});

test('harness prose is not offered as a title', async () => {
  const path = await transcript('c.jsonl', [
    userLine('Caveat: The messages below were generated while running local commands'),
    userLine('the prompt a person actually wrote'),
  ]);
  expect((await claudeAdapter.readHeader(path))?.firstPrompt)
    .toBe('the prompt a person actually wrote');
});

test('a compaction summary is not offered as a title', async () => {
  const path = await transcript('c.jsonl', [
    JSON.stringify({
      type: 'user',
      cwd: CWD,
      isCompactSummary: true,
      message: { role: 'user', content: 'A long summary of everything that came before' },
    }),
    userLine('carry on then'),
  ]);
  expect((await claudeAdapter.readHeader(path))?.firstPrompt).toBe('carry on then');
});

// --- Claude: turn state ---

test('turn state comes from the end of the session, not the start', async () => {
  const open = JSON.stringify({ type: 'user', cwd: CWD, message: { role: 'user', content: 'go' } });
  const close = JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] },
  });
  // Head opens a turn, tail closes one. Reading the head would say "live".
  expect((await claudeAdapter.readHeader(await transcript('c.jsonl', [open, ...GAP, close])))
    ?.lastTurnClosed).toBe(true);
  // And the reverse: head closed, tail open, which is a resumed session.
  expect((await claudeAdapter.readHeader(await transcript('c.jsonl', [
    JSON.stringify({ type: 'user', cwd: CWD, message: { role: 'user', content: 'go' } }),
    close,
    ...GAP,
    open,
  ])))?.lastTurnClosed).toBe(false);
});

test('a tail with nothing to say about the turn says nothing', async () => {
  const path = await transcript('c.jsonl', [
    userLine('go'),
    ...GAP,
    JSON.stringify({ type: 'system', note: 'no boundary here' }),
  ]);
  expect((await claudeAdapter.readHeader(path))?.lastTurnClosed).toBeUndefined();
});

// The claim that makes one rule safe to read from two places. If these ever
// disagree, a row's live badge and its transcript view disagree about the same
// session.
test('both readers of the Claude turn rule give the same answer', async () => {
  const cases = [
    JSON.stringify({ type: 'user', cwd: CWD, message: { role: 'user', content: 'go' } }),
    JSON.stringify({
      type: 'assistant', cwd: CWD,
      message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'a' }] },
    }),
    JSON.stringify({
      type: 'assistant', cwd: CWD,
      message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'text', text: 'a' }] },
    }),
  ];
  for (const line of cases) {
    const viaHeader = (await claudeAdapter.readHeader(await transcript('c.jsonl', [line])))
      ?.lastTurnClosed;
    expect(viaHeader).toBe(claudeAdapter.processLine(line)?.turnClosed);
  }
});

// --- Codex ---

const codexEvent = (type: string) => JSON.stringify({ type: 'event_msg', payload: { type } });

test('codex reports the last turn boundary in its window', async () => {
  const started = await transcript('r.jsonl', [codexEvent('task_complete'), codexEvent('task_started')]);
  expect(await codexAdapter.readTail(started, 64 * 1024)).toBe(false);
  const done = await transcript('r.jsonl', [codexEvent('task_started'), codexEvent('task_complete')]);
  expect(await codexAdapter.readTail(done, 64 * 1024)).toBe(true);
  const aborted = await transcript('r.jsonl', [codexEvent('task_started'), codexEvent('turn_aborted')]);
  expect(await codexAdapter.readTail(aborted, 64 * 1024)).toBe(true);
});

test('codex says nothing when the window holds no boundary', async () => {
  const path = await transcript('r.jsonl', [codexEvent('agent_message')]);
  expect(await codexAdapter.readTail(path, 64 * 1024)).toBeUndefined();
});

test('codex reads only its window, and never half a line', async () => {
  const path = await transcript('r.jsonl', [codexEvent('task_started'), filler(4096)]);
  // The window covers the padding and clips into the boundary line above it. That
  // partial line must be dropped rather than parsed, so the answer is "nothing
  // here" and not a crash or a stale boundary.
  expect(await codexAdapter.readTail(path, 2048)).toBeUndefined();
});

test('both readers of the Codex turn rule give the same answer', async () => {
  for (const type of ['task_started', 'task_complete', 'turn_aborted', 'agent_message']) {
    const line = codexEvent(type);
    const viaTail = await codexAdapter.readTail(await transcript('r.jsonl', [line]), 64 * 1024);
    expect(viaTail).toBe(codexAdapter.processLine(line)?.turnClosed);
  }
});
