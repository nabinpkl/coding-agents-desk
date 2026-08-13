// Claude adapter. Owns everything Claude-specific:
//   - transcript layout at ~/.claude/projects/<slug>/<sessionId>.jsonl
//   - per-message envelope shape (`{type, message:{content:[blocks]}}`)
//   - stop_reason → turn-boundary signals (end_turn closes the turn)
//   - synthetic-user filter patterns (Caveat:, [Request interrupted, ...)
//   - tool-name vocabulary (Read/Edit/Write/Bash/Grep/Glob/...)
//
import { open } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { config, contextWindowFor } from '../../config.ts';
import type {
  ActivityBlock,
  EventCacheHit,
  Header,
  LineResult,
  ParsedLine,
  SourceAdapter,
  TokenUsage,
} from './transcriptTypes.ts';
import {
  metadataBlock,
  metadataText,
  plainBlock,
  plainEvent,
  rawBlock,
  stringifyForDisplay,
} from './plainActivity.ts';
import { classifyClaudeLine } from './lineClass.ts';

const PROJECTS_ROOT = config.claudeProjectsDirectory;
const HEADER_EDGE_BYTES = 32 * 1024;

/**
 * The turn-boundary signal a line carries, or undefined when it carries none.
 *
 * One home for the rule because two readers need it: `processLine`, which feeds
 * the event index, and `readHeader`, which decides from a bounded tail read
 * whether a session's last turn is still open. Two copies would be free to
 * disagree about what "live" means, and both answers land on the same row.
 *
 * A user message OPENS a turn, which is what makes a resumed session live again.
 * An assistant message closes it only on `end_turn`. Every other record is silent
 * on the question, which is why the absent case is undefined and not `true`.
 */
function turnClosedFor(ev: Record<string, unknown>): boolean | undefined {
  if (ev.type === 'user') return false;
  if (ev.type !== 'assistant') return undefined;
  const message = ev.message && typeof ev.message === 'object' && !Array.isArray(ev.message)
    ? ev.message as Record<string, unknown>
    : {};
  return message.stop_reason === 'end_turn';
}

// Bracketed strings the harness injects as user messages (interrupts,
// caveats, etc). Not real user prose, so they are stripped from the rail
// snippet but still surface as ActivityEvents.
const SYNTHETIC_USER_PATTERNS = [
  /^\[Request interrupted/i,
  /^\[no content/i,
  /^Caveat:/i,
];

function isSyntheticUser(s: string): boolean {
  return SYNTHETIC_USER_PATTERNS.some((re) => re.test(s.trim()));
}

function truncate(s: string, n: number): string {
  const flat = s
    .replace(/[\t ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return flat.length > n ? flat.slice(0, n) + '…' : flat;
}

// Input keys worth putting in a row label, most specific first. Consulted for any
// tool without a hand-written rule below, which before this list existed meant every
// tool but six -- `Skill` (42 calls here) and `Agent` (139) rendered with a blank
// label, because there was no fallback at all. The Codex adapter has always had one,
// which is why only Claude went blank.
const CLAUDE_SUMMARY_KEYS = [
  'skill',
  'description',
  'query',
  'url',
  'pattern',
  'command',
  'subject',
  'title',
  'path',
  'file_path',
  'prompt',
] as const;

// Per-tool summary string used as the row's chip label in the activity feed.
function summarizeToolUse(name: string, input?: Record<string, unknown>): string {
  const i = input ?? {};
  const path = typeof i.file_path === 'string' ? (i.file_path as string).split('/').pop() : null;
  if ((name === 'Read' || name === 'Edit' || name === 'Write') && path) return `${name} ${path}`;
  if (name === 'Bash' && typeof i.command === 'string') return (i.command as string).slice(0, 200);
  if (name === 'Grep' && typeof i.pattern === 'string') return `pattern "${i.pattern}"`;
  if (name === 'Glob' && typeof i.pattern === 'string') return i.pattern as string;
  for (const key of CLAUDE_SUMMARY_KEYS) {
    const value = i[key];
    if (typeof value === 'string' && value.trim()) return `${name} ${value.trim().slice(0, 200)}`;
  }
  // Any string input at all beats a blank chip. Keys are read off the transcript, so
  // this walks the object's OWN entries rather than indexing by a name from it.
  for (const [key, value] of Object.entries(i)) {
    if (key && typeof value === 'string' && value.trim()) {
      return `${name} ${value.trim().slice(0, 200)}`;
    }
  }
  return name;
}

// Arrow-prefixed snippet for the rail summary.
function arrowToolUse(name: string, input?: Record<string, unknown>): string {
  const i = input ?? {};
  const path = typeof i.file_path === 'string' ? basename(i.file_path as string) : null;
  if (name === 'Read' && path) return `→ Read ${path}`;
  if (name === 'Edit' && path) return `→ Edit ${path}`;
  if (name === 'Write' && path) return `→ Write ${path}`;
  if (name === 'Bash' && typeof i.command === 'string') return `→ Bash ${i.command}`;
  if (name === 'Grep' && typeof i.pattern === 'string') return `→ Grep "${i.pattern}"`;
  if (name === 'Glob' && typeof i.pattern === 'string') return `→ Glob ${i.pattern}`;
  if (name === 'TodoWrite') return '→ TodoWrite';
  return `→ ${name}`;
}

interface NormalizedClaudeBlock {
  block: ActivityBlock;
  raw: string | null;
  sidecarPath?: string;
}

function normalizeBlocks(content: unknown): NormalizedClaudeBlock[] {
  if (typeof content === 'string') {
    return content.trim()
      ? [{ block: { kind: 'text', text: content }, raw: content }]
      : [{ block: plainBlock(content), raw: content }];
  }
  if (!Array.isArray(content)) {
    return [{ block: plainBlock(content), raw: stringifyForDisplay(content) }];
  }
  const out: NormalizedClaudeBlock[] = [];
  for (const b of content as Array<Record<string, unknown>>) {
    const t = b?.type;
    if (t === 'text' && typeof b.text === 'string' && (b.text as string).trim()) {
      out.push({ block: { kind: 'text', text: b.text as string }, raw: b.text as string });
    } else if (t === 'thinking') {
      // Any `thinking` block is reasoning, even when its `thinking` text is
      // empty (an opaque encrypted `signature` trace). Classify by TYPE, not by
      // non-empty text: reading text here would dump the signature as a Plain
      // JSON card instead of an emittable collapsed reasoning block.
      const thinking = typeof b.thinking === 'string' ? (b.thinking as string) : '';
      out.push({ block: { kind: 'reasoning', text: thinking }, raw: thinking });
    } else if (t === 'tool_use' && typeof b.name === 'string') {
      const input = (b.input as Record<string, unknown> | undefined) ?? {};
      const id = typeof b.id === 'string' ? (b.id as string) : undefined;
      out.push({
        block: {
          kind: 'tool_use',
          tool: b.name as string,
          summary: summarizeToolUse(b.name as string, input),
          input,
          ...(id ? { callId: id } : {}),
        },
        raw: null,
      });
    } else if (t === 'tool_result') {
      let preview = '';
      const c = b.content;
      if (typeof c === 'string') preview = c;
      else if (Array.isArray(c)) {
        for (const sub of c as Array<Record<string, unknown>>) {
          if (sub?.type === 'text' && typeof sub.text === 'string') {
            preview = sub.text as string;
            break;
          }
        }
      }
      if (preview) {
        const PREVIEW_CAP = 16000;
        const useId = typeof b.tool_use_id === 'string' ? (b.tool_use_id as string) : undefined;
        const idPart = useId ? { callId: useId } : {};
        // Harness persisted the full output to a sidecar file. Mark the
        // block as truncated using the size hint in the envelope so the
        // Agent Panel can offer "Show full output" — extractBlockRaw will
        // then resolve the sidecar on demand.
        const persistedSize = parsePersistedSize(preview);
        if (persistedSize !== null && persistedSize > preview.length) {
          const sidecarPath = persistedOutputPath(preview);
          out.push({
            block: {
              kind: 'tool_result',
              preview: preview.slice(0, PREVIEW_CAP),
              hiddenChars: persistedSize - preview.length,
              hiddenLines: 0,
              ...idPart,
            },
            raw: preview,
            ...(sidecarPath ? { sidecarPath } : {}),
          });
        } else if (preview.length > PREVIEW_CAP) {
          const kept = preview.slice(0, PREVIEW_CAP);
          const dropped = preview.slice(PREVIEW_CAP);
          out.push({
            block: {
              kind: 'tool_result',
              preview: kept,
              hiddenChars: dropped.length,
              hiddenLines: (dropped.match(/\n/g) || []).length,
              ...idPart,
            },
            raw: preview,
          });
        } else {
          out.push({ block: { kind: 'tool_result', preview, ...idPart }, raw: preview });
        }
      } else {
        const serialized = stringifyForDisplay(b);
        out.push({ block: plainBlock(b), raw: serialized });
      }
    } else {
      const serialized = stringifyForDisplay(b);
      out.push({ block: plainBlock(b), raw: serialized });
    }
  }
  return out.length > 0
    ? out
    : [{ block: plainBlock(content), raw: stringifyForDisplay(content) }];
}

// The harness stamps `<synthetic>` as the model on lines it injected itself.
// That is not a model switch and not an unknown model, so it must not resolve to
// a null window: the merge in the event index carries the last real model and
// limit forward for any line that names no model.
const SYNTHETIC_MODEL = '<synthetic>';

function assistantModel(message: Record<string, unknown>): string | undefined {
  const model = typeof message.model === 'string' ? message.model.trim() : '';
  if (!model || model === SYNTHETIC_MODEL) return undefined;
  return model;
}

// Pull total token occupancy off an assistant line. Sum of input +
// cache_creation + cache_read + output gives "what the model held in
// context at the end of this turn", which is what the Agent Panel meter
// shows. Post-compaction turns report a much smaller sum automatically,
// so no compaction-specific math is needed.
//
// Claude does not publish the context window in the transcript, so the limit is
// resolved HERE from the config table rather than left null for the panel to
// guess at. The model changes mid-session (13 of 129 sessions in this project),
// so it is read per line, not once per session.
function extractClaudeUsage(
  usage: unknown,
  model: string | undefined,
  ts: number,
): TokenUsage | null {
  if (!usage || typeof usage !== 'object') return null;
  const u = usage as Record<string, unknown>;
  const input = typeof u.input_tokens === 'number' ? u.input_tokens : 0;
  const cacheCreate = typeof u.cache_creation_input_tokens === 'number' ? u.cache_creation_input_tokens : 0;
  const cacheRead = typeof u.cache_read_input_tokens === 'number' ? u.cache_read_input_tokens : 0;
  const output = typeof u.output_tokens === 'number' ? u.output_tokens : 0;
  const current = input + cacheCreate + cacheRead + output;
  if (current <= 0) return null;
  return {
    current,
    limit: contextWindowFor(model),
    updatedAt: ts || Date.now(),
    ...(model ? { model } : {}),
  };
}

// Per-turn prompt-cache summary for the cache-hit badge. A "cache hit" for
// Claude is input served from the prompt cache (`cache_read_input_tokens`);
// `input` is the whole prompt, including the portion written to cache this
// turn (`cache_creation_input_tokens`), so the fraction reads as
// cache_read / (input + cache_read + cache_creation).
function extractClaudeCacheHit(usage: unknown): EventCacheHit | undefined {
  if (!usage || typeof usage !== 'object') return undefined;
  const u = usage as Record<string, unknown>;
  const input = typeof u.input_tokens === 'number' ? u.input_tokens : 0;
  const cacheCreate = typeof u.cache_creation_input_tokens === 'number' ? u.cache_creation_input_tokens : 0;
  const cacheRead = typeof u.cache_read_input_tokens === 'number' ? u.cache_read_input_tokens : 0;
  const total = input + cacheCreate + cacheRead;
  if (total <= 0) return undefined;
  return { cached: cacheRead, input: total };
}

function timestampMs(value: unknown): number {
  if (typeof value !== 'string') return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

interface NormalizedClaudeLine {
  result: LineResult;
  rawBlocks: NormalizedClaudeBlock[];
}

// `attachment` is one record type carrying twenty unrelated things, and labelling
// them all `Attachment` is what made 978 `diagnostics` rows -- real type errors --
// indistinguishable from 4,891 rows of hook telemetry in this project's transcripts.
// The subtype is the label.
const CLAUDE_ATTACHMENT_LABELS: Readonly<Record<string, string>> = {
  diagnostics: 'Diagnostics',
  queued_command: 'Queued Command',
  edited_text_file: 'Edited File',
  file: 'File',
  compact_file_reference: 'Compacted File',
  structured_output: 'Structured Output',
  goal_status: 'Goal Status',
  nested_memory: 'Memory',
  plan_mode: 'Plan Mode',
  plan_mode_exit: 'Plan Mode Exit',
  plan_mode_reentry: 'Plan Mode Re-entry',
  plan_file_reference: 'Plan File',
  invoked_skills: 'Skills Invoked',
  task_status: 'Task Status',
  task_reminder: 'Task Reminder',
  async_hook_response: 'Hook',
  hook_success: 'Hook',
  hook_failure: 'Hook Failed',
  hook_additional_context: 'Hook Context',
  deferred_tools_delta: 'Deferred Tools',
  agent_listing_delta: 'Agent Listing',
  mcp_instructions_delta: 'MCP Instructions',
  command_permissions: 'Command Permissions',
  skill_listing: 'Skill Listing',
  date_change: 'Date Change',
  auto_mode: 'Auto Mode',
  max_turns_reached: 'Max Turns Reached',
  opened_file_in_ide: 'Opened In IDE',
};

/**
 * Label for one `attachment` record, from its subtype.
 *
 * An unmapped subtype keeps the subtype itself rather than collapsing back to
 * `Attachment`: a name we have not seen before is still more use than none, and a
 * future harness release adding one should read as unfamiliar, not as generic.
 */
function attachmentLabel(record: Record<string, unknown>): string {
  const attachment = record.attachment;
  if (!attachment || typeof attachment !== 'object' || Array.isArray(attachment)) {
    return 'Attachment';
  }
  const subtype = (attachment as Record<string, unknown>).type;
  if (typeof subtype !== 'string' || !subtype) return 'Attachment';
  return CLAUDE_ATTACHMENT_LABELS[subtype] ?? `Attachment: ${subtype}`;
}

const CLAUDE_METADATA_LABELS: Readonly<Record<string, string>> = {
  attachment: 'Attachment',
  'last-prompt': 'Last Prompt',
  'custom-title': 'Title',
  mode: 'Mode',
  'queue-operation': 'Queue Operation',
  system: 'System',
  'permission-mode': 'Permission Mode',
  'file-history-snapshot': 'File History Snapshot',
};

function normalizedLine(line: string): NormalizedClaudeLine | null {
  if (!line.trim()) return null;
  let ev: Record<string, unknown>;
  try {
    const parsed = JSON.parse(line);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { result: { event: plainEvent(line) }, rawBlocks: [{ block: plainBlock(line), raw: line }, { block: rawBlock(), raw: line }] };
    }
    ev = parsed as Record<string, unknown>;
  } catch {
    return { result: { event: plainEvent(line) }, rawBlocks: [{ block: plainBlock(line), raw: line }, { block: rawBlock(), raw: line }] };
  }
  const normalized = normalizedRecord(line, ev);
  // Stamped here, once, from the parsed record rather than the rendered blocks:
  // `normalizedRecord` returns from a dozen branches, and a new branch that
  // forgot this would silently leak a machinery row into the nice view. An
  // unparseable line above keeps the default, which is content -- we cannot tell
  // what it is, so it stays visible.
  normalized.result.lineClass = classifyClaudeLine(ev);
  return normalized;
}

function normalizedRecord(
  line: string,
  ev: Record<string, unknown>,
): NormalizedClaudeLine {
  const t = ev.type;
  const cwd = typeof ev.cwd === 'string' && ev.cwd.trim() ? ev.cwd.trim() : undefined;
  const ts = timestampMs(ev.timestamp);

  const appendCommon = (blocks: NormalizedClaudeBlock[]): NormalizedClaudeBlock[] => {
    const next = [...blocks];
    if (cwd) next.push({ block: metadataBlock('Working Directory', cwd), raw: null });
    next.push({ block: rawBlock(), raw: line });
    return next;
  };

  // Claude harness writes (and rewrites) the session name as its own line
  // type. The bounded session probe keeps the latest observed title.
  if (t === 'ai-title') {
    const title = typeof ev.aiTitle === 'string' && ev.aiTitle.trim() ? ev.aiTitle.trim() : undefined;
    const rawBlocks = appendCommon(title
      ? [{ block: metadataBlock('Title', title), raw: null }]
      : [{ block: plainBlock(ev), raw: stringifyForDisplay(ev) }]);
    return {
      result: {
        event: { ts, type: 'system', blocks: rawBlocks.map(({ block }) => block) },
        ...(title ? { title } : {}),
        ...(cwd ? { cwd } : {}),
      },
      rawBlocks,
    };
  }

  if (typeof t === 'string' && t !== 'user' && t !== 'assistant') {
    if (t === 'system' && ev.subtype === 'compact_boundary') {
      const rawBlocks = appendCommon([{ block: { kind: 'compaction' }, raw: null }]);
      return {
        result: { event: { ts, type: 'system', blocks: rawBlocks.map(({ block }) => block) }, ...(cwd ? { cwd } : {}) },
        rawBlocks,
      };
    }
    const label = t === 'attachment' ? attachmentLabel(ev) : CLAUDE_METADATA_LABELS[t];
    if (label) {
      const titleCandidate = t === 'custom-title'
        ? [ev.customTitle, ev.title, ev.value].find((value) => typeof value === 'string' && value.trim()) as string | undefined
        : undefined;
      const text = titleCandidate?.trim() || metadataText(ev);
      const rawBlocks = appendCommon([{ block: metadataBlock(label, text), raw: null }]);
      return {
        result: {
          event: { ts, type: 'system', blocks: rawBlocks.map(({ block }) => block) },
          ...(titleCandidate ? { title: titleCandidate.trim() } : {}),
          ...(cwd ? { cwd } : {}),
        },
        rawBlocks,
      };
    }
    const rawBlocks = appendCommon([{ block: plainBlock(ev), raw: stringifyForDisplay(ev) }]);
    return {
      result: { event: { ts, type: 'system', blocks: rawBlocks.map(({ block }) => block) }, ...(cwd ? { cwd } : {}) },
      rawBlocks,
    };
  }

  if (t !== 'user' && t !== 'assistant') {
    const rawBlocks = appendCommon([{ block: plainBlock(ev), raw: stringifyForDisplay(ev) }]);
    return { result: { event: { ts, type: 'system', blocks: rawBlocks.map(({ block }) => block) }, ...(cwd ? { cwd } : {}) }, rawBlocks };
  }

  const message = ev.message && typeof ev.message === 'object' && !Array.isArray(ev.message)
    ? ev.message as Record<string, unknown>
    : {};

  // Compaction marker. The harness injects a synthetic user message with
  // `isCompactSummary: true` whose content is the summary that replaced
  // earlier turns in the model's view. Render as a single banner block so
  // the activity feed shows where the context was reset, instead of
  // showing the full summary as user prose.
  if (t === 'user' && ev.isCompactSummary === true) {
    const rawBlocks = appendCommon([{ block: { kind: 'compaction' }, raw: null }]);
    return { result: { event: { ts, type: 'system', blocks: rawBlocks.map(({ block }) => block) }, turnClosed: false, ...(cwd ? { cwd } : {}) }, rawBlocks };
  }

  const contentBlocks = normalizeBlocks(message.content);
  const stateBlocks: NormalizedClaudeBlock[] = [];
  const usage = t === 'assistant'
    ? extractClaudeUsage(message.usage, assistantModel(message), ts)
    : null;
  if (usage) stateBlocks.push({ block: metadataBlock('Token Usage', `${usage.current.toLocaleString()} tokens`), raw: null });
  if (typeof message.stop_reason === 'string' && message.stop_reason) {
    stateBlocks.push({ block: metadataBlock('Stop Reason', message.stop_reason), raw: null });
  }
  const rawBlocks = appendCommon([...contentBlocks, ...stateBlocks]);
  const semanticType = t === 'assistant' && contentBlocks.every(({ block }) => block.kind === 'reasoning')
    ? 'reasoning'
    : t;
  // Turn-boundary signal per line. `t` is user or assistant by here, so the rule
  // always has an answer; the `?? false` is for the type, not for a real case.
  const turnClosed = turnClosedFor(ev) ?? false;
  // The Anthropic message id the live `/v1/messages` stream also names on
  // `message_start`, so the viewer can hand a streaming live tail off to the
  // durable transcript once it contains this same id.
  const rawMessageId = typeof message.id === 'string' ? (message.id as string).trim() : '';
  const result: LineResult = {
    turnClosed,
    event: {
      ts,
      type: semanticType,
      blocks: rawBlocks.map(({ block }) => block),
      ...(rawMessageId ? { messageId: rawMessageId } : {}),
    },
  };
  if (usage) result.usage = usage;
  if (t === 'assistant') {
    const cacheHit = extractClaudeCacheHit(message.usage);
    if (cacheHit) result.cacheHit = cacheHit;
  }
  if (cwd) result.cwd = cwd;
  return { result, rawBlocks };
}

function processLine(line: string): LineResult | null {
  return normalizedLine(line)?.result ?? null;
}

function snippetFor(parsed: ParsedLine): string {
  if (parsed.type === 'assistant') {
    for (let i = parsed.blocks.length - 1; i >= 0; i--) {
      const b = parsed.blocks[i]!;
      if (b.kind === 'text' && b.text && b.text.trim()) return truncate(b.text, 800);
    }
    for (let i = parsed.blocks.length - 1; i >= 0; i--) {
      const b = parsed.blocks[i]!;
      if (b.kind === 'tool_use' && b.tool) return truncate(arrowToolUse(b.tool, b.input), 200);
    }
    return '';
  }
  if (parsed.type === 'user') {
    for (const b of parsed.blocks) {
      if (b.kind === 'text' && b.text && b.text.trim()) {
        if (isSyntheticUser(b.text)) return '';
        return truncate(`→ ${b.text}`, 800);
      }
    }
  }
  return '';
}

// Parse the `Output too large (43KB)` / `(2.1MB)` size hint inside a
// `<persisted-output>` envelope into an approximate char count, so the
// sidecar can stamp hiddenChars on the block. Returns null when the
// envelope is missing or the size is unparseable.
function parsePersistedSize(raw: string): number | null {
  if (!raw.startsWith('<persisted-output>')) return null;
  const m = /Output too large \(([\d.]+)\s*([KMG]?B)\)/i.exec(raw);
  if (!m) return null;
  const n = parseFloat(m[1]!);
  if (!Number.isFinite(n)) return null;
  const unit = (m[2] || 'B').toUpperCase();
  const mult = unit === 'GB' ? 1024 ** 3
    : unit === 'MB' ? 1024 ** 2
    : unit === 'KB' ? 1024
    : 1;
  return Math.round(n * mult);
}

// Pull the sidecar path out of a `<persisted-output>` envelope. Format
// (verified empirically):
//   <persisted-output>
//   Output too large (43KB). Full output saved to: /abs/path/to/file.txt
//
//   Preview (first 2KB):
//   ...
// Returns the absolute path if the envelope matches, else null.
function persistedOutputPath(raw: string): string | null {
  if (!raw.startsWith('<persisted-output>')) return null;
  const m = /Full output saved to:\s*(\S[^\n]*?)\s*(?:\n|$)/.exec(raw);
  const p = m?.[1]?.trim();
  return p && p.startsWith('/') ? p : null;
}

// Read the sidecar file, but only if it's under ~/.claude/projects. A
// transcript line is technically attacker-influenced (the harness writes
// what the model produces during a tool_result), so we refuse paths that
// resolve outside the projects tree. This is a defense in depth — the
// harness itself controls these writes today.
async function readSidecar(sidecarPath: string): Promise<string | null> {
  const abs = resolve(sidecarPath);
  if (!abs.startsWith(PROJECTS_ROOT + '/')) return null;
  try {
    return await Bun.file(abs).text();
  } catch {
    return null;
  }
}

// Re-walk the line's content array the same way parseBlocks does, but
// return the FULL untruncated text of the block at blockIndex. Block index
// alignment is critical: parseBlocks skips empty text and empty tool_result
// entries, so the Agent Panel's stored block index reflects "emitted" order,
// not raw position. We replicate that filter here.
//
// When the harness persisted the output to a sidecar file (large bash
// results), we resolve the path inside the envelope and return the
// sidecar's contents instead of the 2 KB transcript preview.
async function extractBlockRaw(line: string, blockIndex: number): Promise<string | null> {
  const normalized = normalizedLine(line);
  const selected = normalized?.rawBlocks[blockIndex];
  if (!selected) return null;
  if (selected.sidecarPath) return await readSidecar(selected.sidecarPath) ?? selected.raw;
  return selected.raw;
}

/** The prose of a user message, whose content is either a string or a block list. */
function userText(message: unknown): string | undefined {
  if (typeof message === 'string') return message.trim() || undefined;
  if (!message || typeof message !== 'object' || Array.isArray(message)) return undefined;
  const content = (message as Record<string, unknown>).content;
  if (typeof content === 'string') return content.trim() || undefined;
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const record = block as Record<string, unknown>;
    if (record.type !== 'text') continue;
    if (typeof record.text === 'string' && record.text.trim()) return record.text.trim();
  }
  return undefined;
}

/**
 * The opening prompt a line carries, from the two records that can hold one.
 *
 * `user` is the ordinary case. `queue-operation`/`enqueue` is how a command that
 * was queued rather than typed arrives, and for some sessions it is the ONLY
 * record of the prompt: a `/security-review` run has no `user` line near its head
 * at all, so without this branch those sessions render as their own UUID.
 *
 * A compaction summary is skipped. It is a resumed context rather than something
 * a person asked for, and it is long, so it makes a uniquely bad title.
 */
function promptText(ev: Record<string, unknown>): string | undefined {
  if (ev.type === 'user') {
    if (ev.isCompactSummary === true) return undefined;
    const text = userText(ev.message);
    // The harness writes interrupts and caveats as user messages. They are not
    // prose a person chose, so they are no more useful as a title than the id.
    if (text && SYNTHETIC_USER_PATTERNS.some((pattern) => pattern.test(text))) return undefined;
    return text;
  }
  if (ev.type === 'queue-operation' && ev.operation === 'enqueue') {
    return typeof ev.content === 'string' ? ev.content.trim() || undefined : undefined;
  }
  return undefined;
}

/**
 * The opening prompt of a session whose first record does not fit the head window.
 *
 * A queued command carries its whole payload on one line, and `/security-review`
 * enqueues a file list, so that single record can be larger than the whole 32 KB
 * edge. The window then holds one truncated line, `JSON.parse` refuses it, and the
 * session has no title and no prompt left to fall back to -- it renders as its own
 * UUID. Three sessions in this repo land there.
 *
 * The prompt is at the FRONT of that record though, so it is inside the window; only
 * the closing brace is missing. So the string value is read directly rather than the
 * object being repaired, because a truncated object cannot be repaired without
 * guessing what was cut.
 */
function promptFromOversizedRecord(text: string): string | undefined {
  const match = /"content":"((?:[^"\\]|\\.){0,400})/.exec(text);
  if (!match?.[1]) return undefined;
  // The capture can end mid-escape, which is not a valid string body. Drop the stub.
  const body = match[1].replace(/\\u[0-9a-fA-F]{0,3}$|\\$/, '');
  try {
    return (JSON.parse(`"${body}"`) as string).trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * What the catalog knows about a session without reading its body: the two 32 KB
 * edges, and everything the session list needs pulled out of them.
 *
 * The edge size is measured, not guessed. Across this repo's 119 Claude
 * transcripts, 113 carry their title inside these two windows; of the six that do
 * not, five have no title anywhere in the file, so a full scan finds nothing more.
 * Widening to 64 KB recovers one session and 128 KB recovers none, which is why
 * the answer to a missing title is `promptText` above rather than a bigger read.
 */
async function readHeader(filePath: string): Promise<Header | null> {
  let fh: Awaited<ReturnType<typeof open>>;
  try { fh = await open(filePath, 'r'); } catch { return null; }
  try {
    const metadata = await fh.stat();
    const ranges = metadata.size <= HEADER_EDGE_BYTES * 2
      ? [{ start: 0, length: metadata.size }]
      : [
        { start: 0, length: HEADER_EDGE_BYTES },
        { start: metadata.size - HEADER_EDGE_BYTES, length: HEADER_EDGE_BYTES },
      ];
    const out: Header = {};
    // Kept apart and ranked at the end rather than overwriting each other in file
    // order, because file order gives the wrong answer: the harness re-emits its
    // generated title as a session goes on, so a name the USER chose is routinely
    // followed by a generated one, and last-write-wins would rename their session
    // back for them.
    let aiTitle: string | undefined;
    let customTitle: string | undefined;
    for (const [index, range] of ranges.entries()) {
      // A small file is one range that is both edges, so it answers both
      // questions. A large one splits them, and each question has exactly one
      // range that can answer it: the head knows how the session opened, the tail
      // knows whether its turn is still open. Reading either from the wrong end
      // gives a confident wrong answer.
      const isHead = index === 0;
      const isTail = index === ranges.length - 1;
      const buf = Buffer.alloc(range.length);
      const { bytesRead } = await fh.read(buf, 0, buf.length, range.start);
      const window = buf.toString('utf-8', 0, bytesRead);
      const lines = window.split('\n');
      // A window that starts mid-file almost certainly starts mid-line.
      if (range.start > 0) lines.shift();
      for (const line of lines) {
        if (!line) continue;
        let ev: Record<string, unknown>;
        try {
          const parsed = JSON.parse(line);
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
          ev = parsed as Record<string, unknown>;
        } catch { continue; }
        if (typeof ev.cwd === 'string') out.cwd = ev.cwd;
        if (typeof ev.gitBranch === 'string') out.gitBranch = ev.gitBranch;
        if (typeof ev.entrypoint === 'string') out.entrypoint = ev.entrypoint;
        if (typeof ev.aiTitle === 'string' && ev.aiTitle.trim()) aiTitle = ev.aiTitle.trim();
        if (typeof ev.customTitle === 'string' && ev.customTitle.trim()) {
          customTitle = ev.customTitle.trim();
        }
        // Last one in the window wins: this is the turn state as of the most
        // recent line that spoke to it.
        if (isTail) {
          const closed = turnClosedFor(ev);
          if (closed !== undefined) out.lastTurnClosed = closed;
        }
        if (isHead) out.firstPrompt ??= promptText(ev);
      }
      // Nothing in the head window parsed and there was no line break in it: one
      // record overran the whole window. What is visible of it is still its front,
      // which is where the prompt is.
      if (isHead && !out.firstPrompt && !window.includes('\n')) {
        out.firstPrompt = promptFromOversizedRecord(window);
      }
    }
    out.title = customTitle ?? aiTitle;
    return out.cwd ? out : null;
  } finally {
    await fh.close();
  }
}

function filePathToSessionId(p: string): string | null {
  if (!p.endsWith('.jsonl')) return null;
  // Require the path to be under PROJECTS_ROOT so the watcher does not claim
  // a Codex rollout that happens to live at <something>/foo.jsonl.
  if (!p.startsWith(PROJECTS_ROOT)) return null;
  const sid = basename(p, '.jsonl');
  if (sid.startsWith('_')) return null;
  return sid;
}

export const claudeAdapter = {
  id: 'claude',
  filePathToSessionId,
  readHeader,
  processLine,
  snippetFor,
  extractBlockRaw,
} satisfies SourceAdapter & {
  filePathToSessionId(path: string): string | null;
  readHeader(path: string): Promise<Header | null>;
};
