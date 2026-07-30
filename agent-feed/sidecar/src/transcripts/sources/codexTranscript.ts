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
      }]);
    }
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

export const codexAdapter: SourceAdapter = {
  id: 'codex',
  processLine,
  snippetFor,
  extractBlockRaw,
};

export { resolveStateDbPath };
