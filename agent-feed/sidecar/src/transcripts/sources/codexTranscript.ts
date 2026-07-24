// Codex adapter. Owns everything Codex-specific:
//   - rollouts laid out by date at ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
//   - line envelope shape: {timestamp, type, payload:{type, ...}}
//   - response_item / event_msg dispatch
//   - SQLite-backed discovery via ~/.codex/state_<N>.sqlite (threads table)
//
// Every nonempty JSONL line becomes exactly one ActivityEvent, optionally
// alongside state updates. Turn boundaries come from event_msg/task_started
// (opens), /task_complete and /turn_aborted (close).
//
// Discovery uses chokidar on SESSIONS_ROOT with depth: 3 (year/month/day/file).
// Node's built-in fs.watch on macOS is unreliable for directory watches: it
// can silently stop firing under FSEvents flakiness or never deliver a
// follow-up event when a watcher attached to a parent dir is supposed to
// surface a child file. chokidar wraps the platform watcher with error
// recovery and consistent add semantics across macOS/Linux. As a second
// belt, watcher.ts calls `rescan` periodically to catch anything chokidar
// also dropped.

import { Database } from 'bun:sqlite';
import { open, readdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import chokidar, { type FSWatcher } from 'chokidar';
import { config } from '../../config.ts';
import type {
  ActivityBlock,
  DiscoveryHandle,
  Header,
  LineResult,
  ParsedLine,
  Session,
  SourceAdapter,
} from './transcriptTypes.ts';
import {
  metadataBlock,
  metadataText,
  plainBlock,
  plainEvent,
  rawBlock,
  stringifyForDisplay,
} from './plainActivity.ts';

const CODEX_HOME = config.codexHomeDirectory;
const SESSIONS_ROOT = join(CODEX_HOME, 'sessions');

// Codex Desktop creates scratch workspaces under ~/Documents/Codex/<date>/...
// for its intro/preview flows. Filter so the rail stays project-focused.
const SCRATCH_CWD_RE = /\/Documents\/Codex\//;
const ROLLOUT_NAME_RE = /^rollout-[\d-]+T[\d-]+-([0-9a-f-]{36})\.jsonl$/;

// Picks the highest-version state_<N>.sqlite. Codex migrates this DB and
// bumps the suffix; globbing keeps the adapter working across version bumps
// without a code change as long as the columns we read remain present.
function resolveStateDbPath(): string | null {
  let entries: string[] = [];
  try { entries = readdirSync(CODEX_HOME); } catch { return null; }
  let best: { n: number; path: string } | null = null;
  for (const name of entries) {
    const m = /^state_(\d+)\.sqlite$/.exec(name);
    if (!m) continue;
    const n = Number(m[1]);
    if (!best || n > best.n) best = { n, path: join(CODEX_HOME, name) };
  }
  return best?.path ?? null;
}

const STATE_DB_PATH = resolveStateDbPath();

function tsMs(line: { timestamp?: string } | undefined): number {
  const t = line?.timestamp;
  if (typeof t !== 'string') return 0;
  const parsed = Date.parse(t);
  return Number.isFinite(parsed) ? parsed : 0;
}

function truncate(s: string, n: number): string {
  const flat = s
    .replace(/[\t ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return flat.length > n ? flat.slice(0, n) + '…' : flat;
}

// Build a tool_result block with truncation metadata so the Agent Panel can
// render a "+N lines / +M chars" footer when the sidecar had to cap output.
function makeToolResultBlock(raw: string): ActivityBlock {
  const PREVIEW_CAP = 16000;
  if (raw.length <= PREVIEW_CAP) {
    return { kind: 'tool_result', preview: raw };
  }
  const kept = raw.slice(0, PREVIEW_CAP);
  const dropped = raw.slice(PREVIEW_CAP);
  return {
    kind: 'tool_result',
    preview: kept,
    hiddenChars: dropped.length,
    hiddenLines: (dropped.match(/\n/g) || []).length,
  };
}

// Codex content blocks are typed by `type: 'input_text' | 'output_text'`.
// Both carry the prose in `.text`.
function joinTextContent(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const b of content as Array<Record<string, unknown>>) {
    const t = b?.type;
    if ((t === 'input_text' || t === 'output_text') && typeof b.text === 'string') {
      parts.push(b.text as string);
    }
  }
  return parts.join('\n\n');
}

// function_call_output.output is either a plain string (exec_command,
// apply_patch, read_file…) or a content-block array (click, some other
// UI-driving tools). Returns '' when neither shape carries usable text so
// the caller can decide whether to drop the event.
function outputToString(out: unknown): string {
  if (typeof out === 'string') return out;
  if (Array.isArray(out)) return joinTextContent(out);
  return '';
}

function parseArgs(raw: unknown): { input: Record<string, unknown>; raw: string } {
  if (typeof raw !== 'string') return { input: {}, raw: '' };
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { input: parsed as Record<string, unknown>, raw };
    }
  } catch { /* fall through */ }
  return { input: {}, raw };
}

function summarizeToolUse(name: string, input: Record<string, unknown>, raw: string): string {
  if (name === 'exec_command' && typeof input.cmd === 'string') {
    return (input.cmd as string).slice(0, 200);
  }
  if (name === 'apply_patch' && typeof input.file_path === 'string') {
    return `apply_patch ${basename(input.file_path as string)}`;
  }
  if (name === 'read_file' && typeof input.path === 'string') {
    return `read_file ${basename(input.path as string)}`;
  }
  if (name === 'shell' && typeof input.command === 'string') {
    return (input.command as string).slice(0, 200);
  }
  const firstKey = Object.keys(input)[0];
  if (firstKey && typeof input[firstKey] === 'string') {
    return `${name} ${(input[firstKey] as string).slice(0, 120)}`;
  }
  return name || raw.slice(0, 120);
}

interface ResponseItemPayload {
  type?: string;
  role?: string;
  content?: unknown;
  name?: string;
  arguments?: string;
  input?: unknown;
  // function_call_output.output is usually a string but some tools (e.g.
  // `click`) emit a content array of {type, text} blocks instead. Both
  // shapes are normalized via `outputToString` before reaching the block.
  output?: unknown;
  summary?: unknown;
  // Pairs a function_call with its function_call_output. Same id on both
  // payloads. Format: `call_<random>` (OpenAI Responses API convention).
  call_id?: string;
  message?: unknown;
}

interface EventMsgPayload {
  type?: string;
  text?: string;
  last_agent_message?: string;
  // Populated only on `token_count` payloads. `last_token_usage.total_tokens`
  // is the size of the prompt the model just processed; this is the meter
  // the Agent Panel shows. After compaction it drops automatically.
  info?: {
    last_token_usage?: { total_tokens?: number };
    total_token_usage?: { total_tokens?: number };
    model_context_window?: number;
  };
}

function extractReasoning(p: ResponseItemPayload): string {
  // Codex emits the reasoning trace as `summary` (array of text parts) when
  // configured to expose it. `content` is sometimes populated too. The
  // encrypted_content blob is end-to-end encrypted and unreadable; skip it.
  let text = '';
  if (Array.isArray(p.summary)) {
    const parts: string[] = [];
    for (const s of p.summary as unknown[]) {
      if (typeof s === 'string') parts.push(s);
      else if (s && typeof s === 'object' && typeof (s as { text?: unknown }).text === 'string') {
        parts.push((s as { text: string }).text);
      }
    }
    text = parts.join('\n\n').trim();
  }
  if (!text && Array.isArray(p.content)) text = joinTextContent(p.content).trim();
  return text;
}

interface NormalizedCodexBlock {
  block: ActivityBlock;
  raw: string | null;
}

interface NormalizedCodexLine {
  result: LineResult;
  rawBlocks: NormalizedCodexBlock[];
}

const CODEX_EVENT_LABELS: Readonly<Record<string, string>> = {
  task_started: 'Task Started',
  task_complete: 'Task Completed',
  turn_aborted: 'Task Aborted',
  token_count: 'Token Usage',
  agent_reasoning: 'Agent Reasoning',
  agent_message: 'Agent Message',
  patch_apply_end: 'Patch Applied',
  user_message: 'User Message',
  thread_settings_applied: 'Thread Settings',
  web_search_end: 'Web Search',
  sub_agent_activity: 'Sub-agent Activity',
  context_compacted: 'Context Compacted',
  item_completed: 'Item Completed',
  image_generation_end: 'Image Generation',
  mcp_tool_call_end: 'MCP Tool Call',
};

const CODEX_TOP_LEVEL_LABELS: Readonly<Record<string, string>> = {
  session_meta: 'Session Metadata',
  turn_context: 'Turn Context',
  world_state: 'World State',
  inter_agent_communication_metadata: 'Inter-agent Communication',
};

function normalizeMessageContent(content: unknown): NormalizedCodexBlock[] {
  if (typeof content === 'string') {
    return content.trim()
      ? [{ block: { kind: 'text', text: content }, raw: content }]
      : [{ block: plainBlock(content), raw: content }];
  }
  if (!Array.isArray(content)) {
    return [{ block: plainBlock(content), raw: stringifyForDisplay(content) }];
  }
  const blocks: NormalizedCodexBlock[] = [];
  for (const item of content) {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const record = item as Record<string, unknown>;
      if ((record.type === 'input_text' || record.type === 'output_text') && typeof record.text === 'string' && record.text.trim()) {
        blocks.push({ block: { kind: 'text', text: record.text }, raw: record.text });
        continue;
      }
    }
    blocks.push({ block: plainBlock(item), raw: stringifyForDisplay(item) });
  }
  return blocks.length > 0 ? blocks : [{ block: plainBlock(content), raw: stringifyForDisplay(content) }];
}

function normalizedLine(line: string): NormalizedCodexLine | null {
  if (!line.trim()) return null;
  let ev: { timestamp?: string; type?: string; payload?: Record<string, unknown> };
  try {
    const parsed = JSON.parse(line);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      const blocks = [{ block: plainBlock(line), raw: line }, { block: rawBlock(), raw: line }];
      return { result: { event: plainEvent(line) }, rawBlocks: blocks };
    }
    ev = parsed as typeof ev;
  } catch {
    const blocks = [{ block: plainBlock(line), raw: line }, { block: rawBlock(), raw: line }];
    return { result: { event: plainEvent(line) }, rawBlocks: blocks };
  }
  const ts = tsMs(ev);
  const top = ev.type;
  const p = ev.payload;

  const finish = (
    type: ParsedLine['type'],
    blocks: NormalizedCodexBlock[],
    stateUpdates: Omit<LineResult, 'event'> = {},
  ): NormalizedCodexLine => {
    const rawBlocks = [...blocks, { block: rawBlock(), raw: line }];
    return {
      result: { ...stateUpdates, event: { ts, type, blocks: rawBlocks.map(({ block }) => block) } },
      rawBlocks,
    };
  };

  const plain = (): NormalizedCodexLine => finish('system', [{ block: plainBlock(ev), raw: stringifyForDisplay(ev) }]);

  // Both the top-level `compacted` record and the later
  // `event_msg.context_compacted` signal keep their own source-line banner.
  // The post-compaction token record reports the new smaller context.
  if (top === 'compacted') {
    return finish('system', [{ block: { kind: 'compaction' }, raw: null }]);
  }
  if (!p) return plain();

  if (top === 'event_msg') {
    const pe = p as EventMsgPayload;
    const eventType = typeof pe.type === 'string' ? pe.type : '';
    const label = CODEX_EVENT_LABELS[eventType];
    if (!label) return plain();
    const stateUpdates: Omit<LineResult, 'event'> = {};
    if (eventType === 'task_started') stateUpdates.turnClosed = false;
    if (eventType === 'task_complete' || eventType === 'turn_aborted') stateUpdates.turnClosed = true;
    if (eventType === 'agent_reasoning' && typeof pe.text === 'string' && pe.text.trim()) {
      return finish('reasoning', [{ block: { kind: 'reasoning', text: pe.text.trim() }, raw: pe.text }], stateUpdates);
    }
    if (eventType === 'context_compacted') {
      return finish('system', [{ block: { kind: 'compaction' }, raw: null }], stateUpdates);
    }
    if (pe.type === 'token_count') {
      const last = pe.info?.last_token_usage?.total_tokens;
      if (typeof last === 'number' && last > 0) {
        const limit = typeof pe.info?.model_context_window === 'number'
          ? pe.info.model_context_window
          : null;
        const usage = { current: last, limit, updatedAt: ts || Date.now() };
        const text = limit ? `${last.toLocaleString()} / ${limit.toLocaleString()} tokens` : `${last.toLocaleString()} tokens`;
        return finish('system', [{ block: metadataBlock(label, text), raw: null }], { usage });
      }
      return finish('system', [{ block: metadataBlock(label, metadataText(pe)), raw: null }]);
    }
    const summary = typeof pe.last_agent_message === 'string' && pe.last_agent_message.trim()
      ? pe.last_agent_message.trim()
      : metadataText(pe);
    return finish('system', [{ block: metadataBlock(label, summary), raw: null }], stateUpdates);
  }

  if (top !== 'response_item') {
    const label = typeof top === 'string' ? CODEX_TOP_LEVEL_LABELS[top] : undefined;
    if (!label) return plain();
    const cwd = typeof p.cwd === 'string' && p.cwd.trim() ? p.cwd.trim() : undefined;
    return finish('system', [{ block: metadataBlock(label, metadataText(p)), raw: null }], cwd ? { cwd } : {});
  }
  const pr = p as ResponseItemPayload;

  if (pr.type === 'message') {
    const blocks = normalizeMessageContent(pr.content);
    if (pr.role === 'assistant') {
      return finish('assistant', blocks);
    }
    if (pr.role === 'user') {
      return finish('user', blocks);
    }
    if (pr.role === 'developer' || pr.role === 'system') {
      const label = pr.role === 'developer' ? 'Developer Message' : 'System Message';
      return finish('system', blocks.map((entry) => entry.block.kind === 'text'
        ? { block: metadataBlock(label, entry.block.text), raw: entry.raw }
        : entry));
    }
    return plain();
  }

  if (pr.type === 'function_call' || pr.type === 'custom_tool_call') {
    const name = typeof pr.name === 'string' ? pr.name : '';
    const { input, raw } = parseArgs(pr.type === 'custom_tool_call' ? pr.input : pr.arguments);
    const callId = typeof pr.call_id === 'string' ? pr.call_id : undefined;
    return finish('assistant', [{
      block: {
          kind: 'tool_use',
          tool: name,
          summary: summarizeToolUse(name, input, raw),
          input,
          ...(callId ? { callId } : {}),
      },
      raw: null,
    }]);
  }

  if (pr.type === 'function_call_output' || pr.type === 'custom_tool_call_output') {
    const text = outputToString(pr.output);
    if (!text) return plain();
    const callId = typeof pr.call_id === 'string' ? pr.call_id : undefined;
    const block = makeToolResultBlock(text);
    return finish('user', [{ block: callId ? { ...block, callId } : block, raw: text }]);
  }

  if (pr.type === 'reasoning') {
    const text = extractReasoning(pr);
    if (!text) return plain();
    return finish('reasoning', [{ block: { kind: 'reasoning', text }, raw: text }]);
  }

  if (pr.type === 'agent_message') {
    const text = typeof pr.message === 'string' ? pr.message : metadataText(pr);
    return finish('system', [{ block: metadataBlock('Agent Message', text), raw: null }]);
  }

  return plain();
}

function processLine(line: string): LineResult | null {
  return normalizedLine(line)?.result ?? null;
}

function snippetFor(parsed: ParsedLine): string {
  if (parsed.type === 'assistant') {
    for (const b of parsed.blocks) {
      if (b.kind === 'text' && b.text && b.text.trim()) return truncate(b.text, 800);
    }
    for (const b of parsed.blocks) {
      if (b.kind === 'tool_use' && b.tool) {
        const label = b.summary && b.summary.trim() ? b.summary : b.tool;
        return truncate(`→ ${label}`, 200);
      }
    }
    return '';
  }
  if (parsed.type === 'user') {
    for (const b of parsed.blocks) {
      if (b.kind === 'text' && b.text && b.text.trim()) return truncate(`→ ${b.text}`, 800);
    }
  }
  return '';
}

// Resolve block expansion from the same normalized line used by processLine,
// keeping block indices aligned even when a record contains mixed content.
async function extractBlockRaw(line: string, blockIndex: number): Promise<string | null> {
  return normalizedLine(line)?.rawBlocks[blockIndex]?.raw ?? null;
}

interface SessionMetaPayload {
  cwd?: string;
}

async function readHeader(filePath: string): Promise<Header | null> {
  let fh: Awaited<ReturnType<typeof open>>;
  try { fh = await open(filePath, 'r'); } catch { return null; }
  try {
    const buf = Buffer.alloc(64 * 1024);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const first = buf.toString('utf-8', 0, bytesRead).split('\n')[0];
    if (!first) return null;
    let ev: { type?: string; payload?: SessionMetaPayload };
    try { ev = JSON.parse(first); } catch { return null; }
    if (ev.type !== 'session_meta') return null;
    const cwd = ev.payload?.cwd;
    if (typeof cwd !== 'string' || !cwd) return null;
    if (SCRATCH_CWD_RE.test(cwd)) return null;
    const gitBranch = await readGitBranch(cwd);
    return gitBranch ? { cwd, gitBranch } : { cwd };
  } finally {
    await fh.close();
  }
}

// Codex's session_meta does not carry a branch the way Claude's transcript
// header does. Read it live with git so the rail tile shape matches across
// adapters. Captured at header-read time (once per session), mirroring how
// Claude's gitBranch is fixed at session start. Returns undefined when cwd
// isn't a git repo or git is unavailable. Exported because the cache-load
// backfill in watcher.ts uses the same shape to fill cached sessions that
// were registered before this adapter started capturing the branch.
export async function readGitBranch(cwd: string): Promise<string | undefined> {
  try {
    const proc = Bun.spawn(['git', '-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      stdout: 'pipe',
      stderr: 'ignore',
    });
    const exit = await proc.exited;
    if (exit !== 0) return undefined;
    const out = (await new Response(proc.stdout).text()).trim();
    return out && out !== 'HEAD' ? out : undefined;
  } catch {
    return undefined;
  }
}

function filePathToSessionId(p: string): string | null {
  if (!p.startsWith(SESSIONS_ROOT)) return null;
  const m = ROLLOUT_NAME_RE.exec(basename(p));
  return m?.[1] ?? null;
}

// One-shot SQLite lookup for the human/auto title Codex assigns to a thread.
// Returns null if the DB is missing, the row is absent, or the query throws
// (schema drift). Watcher calls this on idle transitions so the notification
// reflects any mid-run renames Codex performed.
async function refreshTitle(sessionId: string): Promise<string | null> {
  if (!STATE_DB_PATH || !existsSync(STATE_DB_PATH)) return null;
  let db: Database;
  try { db = new Database(STATE_DB_PATH, { readonly: true }); } catch { return null; }
  try {
    const row = db.prepare(
      'SELECT title FROM threads WHERE id = ? LIMIT 1',
    ).get(sessionId) as { title?: string } | undefined;
    const t = row?.title;
    return typeof t === 'string' && t.trim() ? t.trim() : null;
  } catch {
    return null;
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

// SQLite discovery: returns active, non-scratch rollout paths newest-first.
async function* listSessionFilesViaSqlite(): AsyncGenerator<string> {
  if (!STATE_DB_PATH || !existsSync(STATE_DB_PATH)) return;
  let db: Database;
  try { db = new Database(STATE_DB_PATH, { readonly: true }); } catch { return; }
  try {
    const rows = db.prepare(`
      SELECT rollout_path
      FROM threads
      WHERE archived = 0
        AND cwd NOT LIKE '%/Documents/Codex/%'
      ORDER BY updated_at DESC
    `).all() as Array<{ rollout_path?: string }>;
    for (const r of rows) {
      const p = r.rollout_path;
      if (typeof p === 'string' && p.endsWith('.jsonl')) yield p;
    }
  } catch {
    // schema changed or query failed; caller falls back to fs walk
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

// Enumerate every rollout file currently visible via SQLite + FS walk, calling
// `emit` for each (with cross-source deduplication). Shared by `initialScan`
// (drains every file on boot) and `rescan` (periodic re-enumeration as a
// safety belt against missed chokidar `add` events).
async function enumerateRolloutFiles(emit: (filePath: string) => void): Promise<void> {
  const seen = new Set<string>();
  const safeEmit = (filePath: string): void => {
    if (seen.has(filePath)) return;
    seen.add(filePath);
    emit(filePath);
  };

  // Primary path: SQLite gives us active rollouts directly.
  for await (const filePath of listSessionFilesViaSqlite()) {
    safeEmit(filePath);
  }

  // FS walk: covers anything SQLite missed (legacy threads, rows the
  // adapter's WHERE clause excludes, schema-drift errors that aborted the
  // SQLite read).
  let years: string[] = [];
  try { years = await readdir(SESSIONS_ROOT); } catch { return; }
  for (const y of years.sort()) {
    const yPath = join(SESSIONS_ROOT, y);
    let months: string[] = [];
    try { months = await readdir(yPath); } catch { continue; }
    for (const m of months.sort()) {
      const mPath = join(yPath, m);
      let days: string[] = [];
      try { days = await readdir(mPath); } catch { continue; }
      for (const d of days.sort()) {
        const dPath = join(mPath, d);
        let files: string[] = [];
        try { files = await readdir(dPath); } catch { continue; }
        for (const f of files) {
          if (!ROLLOUT_NAME_RE.test(f)) continue;
          safeEmit(join(dPath, f));
        }
      }
    }
  }
}

function startDiscovery(onSessionFile: (path: string) => Promise<void> | void): DiscoveryHandle {
  // Single chokidar watcher on SESSIONS_ROOT covers year/month/day directories
  // and rollout files in one subscription. `ignoreInitial` lets initialScan
  // own the boot-time enumeration (so the sidecar can await every per-file
  // drain before going live); chokidar then fires for net-new files only.
  // depth: 3 = sessions/YYYY/MM/DD/file. usePolling stays off — chokidar's
  // FSEvents backend is the reason we switched away from fs.watch.
  const watcher: FSWatcher = chokidar.watch(SESSIONS_ROOT, {
    ignoreInitial: true,
    depth: 3,
    persistent: true,
    awaitWriteFinish: false,
  });

  watcher.on('add', (p: string) => {
    if (!ROLLOUT_NAME_RE.test(basename(p))) return;
    void onSessionFile(p);
  });

  // chokidar reports backend errors here instead of throwing into the
  // callback. Logging is best-effort; the periodic `rescan` belt covers any
  // files we miss while the watcher is degraded.
  watcher.on('error', (err) => {
    console.error('codex chokidar error:', err);
  });

  const initialScan = async (): Promise<void> => {
    const promises: Array<Promise<void>> = [];
    await enumerateRolloutFiles((filePath) => {
      promises.push(Promise.resolve(onSessionFile(filePath)).then(() => undefined));
    });
    await Promise.all(promises);
  };

  // Periodic re-enumeration. Fire-and-forget per file: rescan returns once
  // it has dispatched every callback, but does not wait on them (safetyScan
  // runs on its own cadence and already drains anything that needs draining).
  const rescan = async (): Promise<void> => {
    await enumerateRolloutFiles((filePath) => {
      void onSessionFile(filePath);
    });
  };

  const teardown = (): void => {
    void watcher.close();
  };

  return { initialScan, rescan, teardown };
}

// Codex's approval/review harness spawns sub-sessions whose first user turn
// is a fixed prompt that audits another session's transcript. The harness
// title-extracts from that first user turn, so the session's `title` starts
// with this literal prefix. Match on it to flag the session as auxiliary;
// digests skip it when picking a project's primary by default.
const AUXILIARY_TITLE_PREFIX = 'The following is the Codex agent history';

function isAuxiliarySession(session: Session): boolean {
  const title = session.title;
  if (typeof title !== 'string' || title.length === 0) return false;
  return title.startsWith(AUXILIARY_TITLE_PREFIX);
}

export const codexAdapter: SourceAdapter = {
  id: 'codex',
  startDiscovery,
  filePathToSessionId,
  readHeader,
  processLine,
  snippetFor,
  refreshTitle,
  isAuxiliarySession,
  extractBlockRaw,
};

// Exposed for ad-hoc inspection / debugging only.
export { listSessionFilesViaSqlite, resolveStateDbPath };
