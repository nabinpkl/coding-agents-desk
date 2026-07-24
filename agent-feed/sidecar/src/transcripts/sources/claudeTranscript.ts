// Claude adapter. Owns everything Claude-specific:
//   - transcript layout at ~/.claude/projects/<slug>/<sessionId>.jsonl
//   - per-message envelope shape (`{type, message:{content:[blocks]}}`)
//   - stop_reason → turn-boundary signals (end_turn closes the turn)
//   - synthetic-user filter patterns (Caveat:, [Request interrupted, ...)
//   - tool-name vocabulary (Read/Edit/Write/Bash/Grep/Glob/...)
//
import { open } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { config } from '../../config.ts';
import type {
  ActivityBlock,
  Header,
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

const PROJECTS_ROOT = config.claudeProjectsDirectory;
const HEADER_EDGE_BYTES = 32 * 1024;

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

// Per-tool summary string used as the row's chip label in the activity feed.
function summarizeToolUse(name: string, input?: Record<string, unknown>): string {
  const i = input ?? {};
  const path = typeof i.file_path === 'string' ? (i.file_path as string).split('/').pop() : null;
  if ((name === 'Read' || name === 'Edit' || name === 'Write') && path) return `${name} ${path}`;
  if (name === 'Bash' && typeof i.command === 'string') return (i.command as string).slice(0, 200);
  if (name === 'Grep' && typeof i.pattern === 'string') return `pattern "${i.pattern}"`;
  if (name === 'Glob' && typeof i.pattern === 'string') return i.pattern as string;
  return '';
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
    } else if (t === 'thinking' && typeof b.thinking === 'string' && b.thinking.trim()) {
      out.push({ block: { kind: 'reasoning', text: b.thinking }, raw: b.thinking });
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

// Pull total token occupancy off an assistant line. Sum of input +
// cache_creation + cache_read + output gives "what the model held in
// context at the end of this turn", which is what the Agent Panel meter
// shows. Post-compaction turns report a much smaller sum automatically,
// so no compaction-specific math is needed.
function extractClaudeUsage(
  usage: unknown,
  ts: number,
): { current: number; limit: number | null; updatedAt: number } | null {
  if (!usage || typeof usage !== 'object') return null;
  const u = usage as Record<string, unknown>;
  const input = typeof u.input_tokens === 'number' ? u.input_tokens : 0;
  const cacheCreate = typeof u.cache_creation_input_tokens === 'number' ? u.cache_creation_input_tokens : 0;
  const cacheRead = typeof u.cache_read_input_tokens === 'number' ? u.cache_read_input_tokens : 0;
  const output = typeof u.output_tokens === 'number' ? u.output_tokens : 0;
  const current = input + cacheCreate + cacheRead + output;
  if (current <= 0) return null;
  // Claude does not publish model_context_window in the transcript.
  // Agent Panel supplies a per-model default keyed off session.source.
  return { current, limit: null, updatedAt: ts || Date.now() };
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
    const label = CLAUDE_METADATA_LABELS[t];
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
  const usage = t === 'assistant' ? extractClaudeUsage(message.usage, ts) : null;
  if (usage) stateBlocks.push({ block: metadataBlock('Token Usage', `${usage.current.toLocaleString()} tokens`), raw: null });
  if (typeof message.stop_reason === 'string' && message.stop_reason) {
    stateBlocks.push({ block: metadataBlock('Stop Reason', message.stop_reason), raw: null });
  }
  const rawBlocks = appendCommon([...contentBlocks, ...stateBlocks]);
  const semanticType = t === 'assistant' && contentBlocks.every(({ block }) => block.kind === 'reasoning')
    ? 'reasoning'
    : t;
  // Turn-boundary signal per line. A user message opens a turn (handles
  // resume: a finished session becomes open again when the user resumes).
  // An assistant message closes the turn only on stop_reason end_turn.
  const turnClosed = t === 'assistant' && message.stop_reason === 'end_turn';
  const result: LineResult = { turnClosed, event: { ts, type: semanticType, blocks: rawBlocks.map(({ block }) => block) } };
  if (usage) result.usage = usage;
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
    for (const range of ranges) {
      const buf = Buffer.alloc(range.length);
      const { bytesRead } = await fh.read(buf, 0, buf.length, range.start);
      const lines = buf.toString('utf-8', 0, bytesRead).split('\n');
      if (range.start > 0) lines.shift();
      for (const line of lines) {
        if (!line) continue;
        let ev: {
          cwd?: string;
          gitBranch?: string;
          entrypoint?: string;
          aiTitle?: string;
          customTitle?: string;
        };
        try { ev = JSON.parse(line); } catch { continue; }
        if (typeof ev.cwd === 'string') out.cwd = ev.cwd;
        if (typeof ev.gitBranch === 'string') out.gitBranch = ev.gitBranch;
        if (typeof ev.entrypoint === 'string') out.entrypoint = ev.entrypoint;
        if (typeof ev.aiTitle === 'string' && ev.aiTitle.trim()) out.title = ev.aiTitle.trim();
        if (typeof ev.customTitle === 'string' && ev.customTitle.trim()) {
          out.title = ev.customTitle.trim();
        }
      }
    }
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
