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
import { basename, join } from 'node:path';
import { readdirSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { config } from '../../config.ts';
import type {
  ActivityBlock,
  LineResult,
  ParsedLine,
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
import { extractReasoningText, joinTextContent } from './codexReasoning.ts';
import {
  ITEMS_NAMED,
  PATCH_CHANGE_MARKS,
  commandSummary,
  summarizeJsonCall,
  summarizeScriptCall,
} from './codexToolSummary.ts';
import { classifyCodexLine } from './lineClass.ts';

const CODEX_HOME = config.codexHomeDirectory;

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

// function_call_output.output is either a plain string (exec_command,
// apply_patch, read_file…) or a content-block array (click, some other
// UI-driving tools). Returns '' when neither shape carries usable text so
// the caller can decide whether to drop the event.
//
// An array can also carry `input_image` blocks, which `joinTextContent` skips
// because their payload is a data: URI several hundred KB wide. 1,007 outputs
// here carry one, and 444 carry nothing else -- a screenshot the tool returned
// and no words -- so skipping them silently dropped those rows entirely. The
// count goes in; the URI stays out.
function outputToString(out: unknown): string {
  if (typeof out === 'string') return out;
  if (!Array.isArray(out)) return '';
  const text = joinTextContent(out);
  const images = out.filter((block) => (block as { type?: unknown } | null)?.type === 'input_image').length;
  if (images === 0) return text;
  const note = `[${images} image${images === 1 ? '' : 's'}]`;
  return text.trim() ? `${text}\n\n${note}` : note;
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
  if (name === 'apply_patch' && typeof input.file_path === 'string') {
    return `apply_patch ${basename(input.file_path as string)}`;
  }
  if (name === 'read_file' && typeof input.path === 'string') {
    return `read_file ${basename(input.path as string)}`;
  }
  if (name === 'shell' && typeof input.command === 'string') {
    return commandSummary(input.command as string);
  }
  // `input` is empty for a `custom_tool_call`, whose arguments are a script or a
  // patch document rather than JSON, and the JSON reader covers the function
  // calls whose arguments do not lead with a string. Both fell to the tool name
  // below: 38,737 custom tool calls sharing two summaries between them, plus
  // 11,951 function calls with their arguments sitting right there unread.
  return summarizeJsonCall(input, name)
    || summarizeScriptCall(raw, name)
    || name
    || raw.slice(0, 120);
}

interface ResponseItemPayload {
  type?: string;
  role?: string;
  // The item id (msg_.../rs_.../fc_.../fco_...), the same id the live mirror
  // keys its rows by, so the live tail can hand off to the durable row.
  id?: string;
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

// One entry per changed file. Only `type` is read: the `unified_diff` beside it is
// most of what made the raw payload dump 3,343 characters, and belongs in the Raw
// drawer rather than in the row.
interface PatchChange {
  type?: string;
}

interface EventMsgPayload {
  type?: string;
  text?: string;
  last_agent_message?: string;
  // Populated only on `patch_apply_end` payloads.
  stdout?: string;
  stderr?: string;
  success?: boolean;
  // Keyed by absolute file path. `stdout` names the same files but sometimes by
  // a path relative to cwd (500 of 3,219 records here), so the keys are the
  // reliable list.
  changes?: Record<string, PatchChange>;
  // Populated only on `token_count` payloads. `last_token_usage.total_tokens`
  // is the size of the prompt the model just processed; this is the meter
  // the Agent Panel shows. After compaction it drops automatically.
  // `input_tokens` is the FULL prompt and already INCLUDES the cached portion
  // (verified across this project's rollouts: total = input + output, and
  // input - cached is the small freshly-encoded remainder). The cache-hit
  // fraction is therefore `cached_input_tokens / input_tokens`.
  info?: {
    last_token_usage?: {
      input_tokens?: number;
      cached_input_tokens?: number;
      output_tokens?: number;
      total_tokens?: number;
    };
    total_token_usage?: { total_tokens?: number };
    model_context_window?: number;
  };
}

/** `4 files · M FileTab.swift, A FileTabTests.swift, D Old.swift` */
function patchFileSummary(changes: unknown): string {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) return '';
  const entries = changes as Record<string, PatchChange | undefined>;
  const paths = Object.keys(entries);
  if (paths.length === 0) return '';
  const named = paths.slice(0, ITEMS_NAMED).map((path) => {
    const type = entries[path]?.type;
    const mark = (typeof type === 'string' && PATCH_CHANGE_MARKS[type]) || '?';
    return `${mark} ${basename(path)}`;
  });
  const rest = paths.length - named.length;
  const head = `${paths.length} ${paths.length === 1 ? 'file' : 'files'}`;
  return `${head} · ${named.join(', ')}${rest > 0 ? `, +${rest} more` : ''}`;
}

/**
 * The `Patch Applied` row: which files an edit touched, and whether it landed.
 *
 * This fell through to the generic `event_msg` branch and rendered
 * `metadataText(payload)`, so each row was the whole payload as JSON -- unified
 * diffs included. Across the six largest rollouts here that is 3,219 rows of mean
 * 3,343 characters (10.8 MB), of which 777 (24%) hit the 4,096-character cap and
 * were cut mid-diff, making it the largest remaining non-prose row type in the
 * Codex tail.
 *
 * The summary comes from `changes` rather than `stdout` because it is structured:
 * no dependence on the harness's confirmation wording, and the collapsed one-line
 * preview names files instead of repeating "Success. Updated the following files:"
 * on all 3,219 rows. `stdout` is the fallback for a record that carries no
 * `changes` (none here). The full payload, diffs and all, stays one Raw JSON press
 * away.
 *
 * NOT omittable, unlike the duplicated `agent_message`: 1,161 of the 3,219 (36%)
 * come from `apply_patch` run through an `exec` shell call, and their confirmation
 * appears in no other record -- searching the next 40 tool outputs for each one's
 * `stdout` found it 0 times. Dropping the row would lose "did this edit land" for
 * a third of all edits.
 *
 * The failure branch has never rendered: all 3,219 records report `success: true`.
 * It is written for the same reason the hook-failure branch is -- a patch that did
 * not apply is exactly the row a viewer must not have to go looking for.
 */
function patchAppliedBlock(pe: EventMsgPayload, label: string): ActivityBlock {
  const stdout = typeof pe.stdout === 'string' ? pe.stdout.trim() : '';
  const stderr = typeof pe.stderr === 'string' ? pe.stderr.trim() : '';
  const files = patchFileSummary(pe.changes);
  if (pe.success === false) {
    // A failed patch changed nothing, so the file list would describe an edit that
    // did not happen; what it left behind is in `stderr`.
    return metadataBlock('Patch Failed', metadataText(stderr || stdout || pe));
  }
  return metadataBlock(label, files || metadataText(stdout || pe));
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

/**
 * The turn-boundary signal a line carries, or undefined when it carries none.
 *
 * One home for the rule because two readers need it: `processLine`, which feeds
 * the event index, and `readTail`, which decides from a bounded read whether a
 * session's last turn is still open. Two copies would be free to disagree about
 * what "live" means, and both answers land on the same row.
 *
 * Every one of these three types is in CODEX_EVENT_LABELS, so the unlabeled
 * early-return in `normalizedRecord` cannot swallow a boundary this reports.
 */
function turnClosedFor(
  ev: { type?: string; payload?: Record<string, unknown> },
): boolean | undefined {
  if (ev.type !== 'event_msg') return undefined;
  const eventType = ev.payload?.type;
  if (eventType === 'task_started') return false;
  if (eventType === 'task_complete' || eventType === 'turn_aborted') return true;
  return undefined;
}

/**
 * Turn state as of the end of a rollout, from a bounded read of its last bytes.
 *
 * Codex's inventory comes from SQLite, so unlike Claude nothing else opens the
 * rollout file to build a session record -- this read is new work, and the
 * catalog only asks for it for sessions inside the live window, where the answer
 * can still change which bin the row lands in.
 *
 * Undefined when the window carries no boundary line, which the caller reads as
 * "assume closed" rather than guessing from further back.
 */
async function readTail(filePath: string, bytes: number): Promise<boolean | undefined> {
  let fh: Awaited<ReturnType<typeof open>>;
  try { fh = await open(filePath, 'r'); } catch { return undefined; }
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(Math.min(size, bytes));
    const { bytesRead } = await fh.read(buf, 0, buf.length, start);
    const lines = buf.toString('utf-8', 0, bytesRead).split('\n');
    // A window that starts mid-file almost certainly starts mid-line.
    if (start > 0) lines.shift();
    let closed: boolean | undefined;
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
        // Last one in the window wins: this is the turn state as of the most
        // recent line that spoke to it.
        const next = turnClosedFor(parsed as { type?: string; payload?: Record<string, unknown> });
        if (next !== undefined) closed = next;
      } catch { continue; }
    }
    return closed;
  } finally {
    await fh.close();
  }
}

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
  const normalized = normalizedRecord(line, ev);
  // Stamped here, once, from the parsed record rather than the rendered blocks:
  // `normalizedRecord` returns from a dozen branches, and a new branch that forgot
  // this would silently leak a machinery row into the nice view. An unparseable
  // line above keeps the default, which is content -- we cannot tell what it is,
  // so it stays visible.
  normalized.result.lineClass = classifyCodexLine(ev);
  return normalized;
}

function normalizedRecord(
  line: string,
  ev: { timestamp?: string; type?: string; payload?: Record<string, unknown> },
): NormalizedCodexLine {
  const ts = tsMs(ev);
  const top = ev.type;
  const p = ev.payload;

  const finish = (
    type: ParsedLine['type'],
    blocks: NormalizedCodexBlock[],
    stateUpdates: Omit<LineResult, 'event'> = {},
    messageId?: string,
  ): NormalizedCodexLine => {
    const rawBlocks = [...blocks, { block: rawBlock(), raw: line }];
    return {
      result: {
        ...stateUpdates,
        event: {
          ts,
          type,
          blocks: rawBlocks.map(({ block }) => block),
          ...(messageId ? { messageId } : {}),
        },
      },
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
    const closed = turnClosedFor(ev);
    if (closed !== undefined) stateUpdates.turnClosed = closed;
    if (eventType === 'agent_reasoning' && typeof pe.text === 'string' && pe.text.trim()) {
      return finish('reasoning', [{ block: { kind: 'reasoning', text: pe.text.trim() }, raw: pe.text }], stateUpdates);
    }
    if (eventType === 'context_compacted') {
      return finish('system', [{ block: { kind: 'compaction' }, raw: null }], stateUpdates);
    }
    if (eventType === 'patch_apply_end') {
      return finish('system', [{ block: patchAppliedBlock(pe, label), raw: null }], stateUpdates);
    }
    if (pe.type === 'token_count') {
      const lastUsage = pe.info?.last_token_usage;
      const last = typeof lastUsage?.total_tokens === 'number' ? lastUsage.total_tokens : 0;
      const cached = typeof lastUsage?.cached_input_tokens === 'number' ? lastUsage.cached_input_tokens : 0;
      const input = typeof lastUsage?.input_tokens === 'number' ? lastUsage.input_tokens : 0;
      if (last > 0) {
        // `current` is `total_tokens` as published: it already counts the
        // cached portion, because `input_tokens` includes it. The meter is the
        // prompt the model actually held, matching the Claude adapter's sum.
        const current = last;
        // No `model` on the usage: `token_count` does not name one, and Codex
        // needs no name to produce a limit -- it publishes the window itself,
        // and the published value is authoritative (three distinct windows
        // appear across this project's rollouts). The name lives on a separate
        // `turn_context` line, which carries no occupancy, so reaching it would
        // mean threading a second cross-line signal for a cosmetic label.
        // Leaving `model` absent also makes the session merge treat a
        // window-less record as "inherit", which is what the 124 such records
        // in this project need.
        const limit = typeof pe.info?.model_context_window === 'number'
          ? pe.info.model_context_window
          : null;
        const usage = { current, limit, updatedAt: ts || Date.now() };
        const text = limit ? `${current.toLocaleString()} / ${limit.toLocaleString()} tokens` : `${current.toLocaleString()} tokens`;
        // The `token_count` line is machinery, so this cacheHit is re-stamped
        // onto the turn's last text event by the read paths. `input` is the
        // full prompt: `input_tokens` already includes the cached portion, so
        // the fraction `cached / input` is the true cache-hit rate. Both
        // numbers must be present: a record with input but no cache field
        // predates the field (or drifted), and a fabricated 0% would read as
        // authoritative.
        const cacheHit = typeof lastUsage?.input_tokens === 'number'
          && typeof lastUsage?.cached_input_tokens === 'number'
          && input > 0 && cached >= 0
          ? { cached, input }
          : undefined;
        return finish('system', [{ block: metadataBlock(label, text), raw: null }], {
          usage,
          ...(cacheHit ? { cacheHit } : {}),
        });
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
  const itemId = typeof pr.id === "string" && pr.id ? pr.id : undefined;

  if (pr.type === 'message') {
    const blocks = normalizeMessageContent(pr.content);
    if (pr.role === 'assistant') {
      return finish('assistant', blocks, {}, itemId);
    }
    if (pr.role === 'user') {
      return finish('user', blocks, {}, itemId);
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
    }], {}, itemId);
  }

  if (pr.type === 'function_call_output' || pr.type === 'custom_tool_call_output') {
    const text = outputToString(pr.output);
    if (!text) return plain();
    const callId = typeof pr.call_id === 'string' ? pr.call_id : undefined;
    const block = makeToolResultBlock(text);
    return finish('user', [{ block: callId ? { ...block, callId } : block, raw: text }], {}, itemId);
  }

  if (pr.type === 'reasoning') {
    const text = extractReasoningText(pr);
    // Named rather than dumped. 81,905 reasoning items across this project's
    // rollouts carry no readable trace -- Codex exposes `summary` only when
    // configured to, and otherwise the record holds an end-to-end encrypted
    // `encrypted_content` blob. Sending that through `plainBlock` printed the
    // ciphertext as a Plain card, several KB of base64 per row, which is both
    // useless and the largest single thing in the raw view. The Raw JSON drawer
    // still has the exact line for anyone who wants it.
    if (!text) {
      return finish('system', [{
        block: metadataBlock('Reasoning', 'encrypted, no readable trace'),
        raw: null,
      }], {}, itemId);
    }
    return finish('reasoning', [{ block: { kind: 'reasoning', text }, raw: text }], {}, itemId);
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

// `readTail` rides the concrete adapter rather than `SourceAdapter`, the same way
// Claude's `readHeader` does: metadata reads stay off that interface on purpose,
// so nothing that only has a `SourceAdapter` can reach for the disk.
export const codexAdapter = {
  id: 'codex',
  processLine,
  snippetFor,
  extractBlockRaw,
  readTail,
} satisfies SourceAdapter & {
  readTail(path: string, bytes: number): Promise<boolean | undefined>;
};

export { resolveStateDbPath };
