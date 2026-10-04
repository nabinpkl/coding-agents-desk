// The shapes a Codex rollout line carries, and what each one is called on screen.
//
// A line is `{timestamp, type, payload:{type, ...}}`, and the payload is either a
// `response_item` (what the model produced) or an `event_msg` (what the harness did).
// Everything here is about reading one of those, not about turning it into blocks.

import { basename } from 'node:path';
import type { ActivityBlock, LineResult } from "@/transcripts/transcriptTypes";
import { metadataBlock, metadataText, plainBlock, stringifyForDisplay } from "@/transcripts/plainActivity";
import { joinTextContent } from "@/transcripts/codex/codexReasoning";
import {
  ITEMS_NAMED,
  PATCH_CHANGE_MARKS,
  commandSummary,
  summarizeJsonCall,
  summarizeScriptCall,
} from "@/transcripts/codex/codexToolSummary";

export function tsMs(line: { timestamp?: string } | undefined): number {
  const t = line?.timestamp;
  if (typeof t !== 'string') return 0;
  const parsed = Date.parse(t);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function truncate(s: string, n: number): string {
  const flat = s
    .replace(/[\t ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return flat.length > n ? flat.slice(0, n) + '…' : flat;
}

// Build a tool_result block with truncation metadata so the Agent Panel can
// render a "+N lines / +M chars" footer when the sidecar had to cap output.
export function makeToolResultBlock(raw: string): ActivityBlock {
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
export function outputToString(out: unknown): string {
  if (typeof out === 'string') return out;
  if (!Array.isArray(out)) return '';
  const text = joinTextContent(out);
  const images = out.filter((block) => (block as { type?: unknown } | null)?.type === 'input_image').length;
  if (images === 0) return text;
  const note = `[${images} image${images === 1 ? '' : 's'}]`;
  return text.trim() ? `${text}\n\n${note}` : note;
}

export function parseArgs(raw: unknown): { input: Record<string, unknown>; raw: string } {
  if (typeof raw !== 'string') return { input: {}, raw: '' };
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { input: parsed as Record<string, unknown>, raw };
    }
  } catch { /* fall through */ }
  return { input: {}, raw };
}

export function summarizeToolUse(name: string, input: Record<string, unknown>, raw: string): string {
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

export interface ResponseItemPayload {
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
export interface PatchChange {
  type?: string;
}

export interface EventMsgPayload {
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
export function patchFileSummary(changes: unknown): string {
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
export function patchAppliedBlock(pe: EventMsgPayload, label: string): ActivityBlock {
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

export interface NormalizedCodexBlock {
  block: ActivityBlock;
  raw: string | null;
}

export interface NormalizedCodexLine {
  result: LineResult;
  rawBlocks: NormalizedCodexBlock[];
}

export const CODEX_EVENT_LABELS: Readonly<Record<string, string>> = {
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

export const CODEX_TOP_LEVEL_LABELS: Readonly<Record<string, string>> = {
  session_meta: 'Session Metadata',
  turn_context: 'Turn Context',
  world_state: 'World State',
  inter_agent_communication_metadata: 'Inter-agent Communication',
};

/**
 * The turn-boundary signal a line carries, or undefined when it carries none.
 *
 * One home for the rule because two readers need it: `processLine`, which feeds
 * the transcript reads, and `readTail`, which decides from a bounded read whether a
 * session's last turn is still open. Two copies would be free to disagree about
 * what "live" means, and both answers land on the same row.
 *
 * Every one of these three types is in CODEX_EVENT_LABELS, so the unlabeled
 * early-return in `normalizedRecord` cannot swallow a boundary this reports.
 */
export function turnClosedFor(
  ev: { type?: string; payload?: Record<string, unknown> },
): boolean | undefined {
  if (ev.type !== 'event_msg') return undefined;
  const eventType = ev.payload?.type;
  if (eventType === 'task_started') return false;
  if (eventType === 'task_complete' || eventType === 'turn_aborted') return true;
  return undefined;
}
