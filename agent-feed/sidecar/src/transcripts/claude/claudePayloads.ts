// What a Claude transcript line carries: the turn-boundary signal, the tool vocabulary
// its summaries are written in, the blocks a message's content becomes, and what its
// usage record says about tokens and the prompt cache.

import { contextWindowFor } from "@/config";
import type { ActivityBlock, EventCacheHit, TokenUsage } from "@/transcripts/transcriptTypes";
import { basename } from 'node:path';
import { metadataText, plainBlock, stringifyForDisplay } from "@/transcripts/plainActivity";

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
export function turnClosedFor(ev: Record<string, unknown>): boolean | undefined {
  if (ev.type === 'user') return false;
  if (ev.type !== 'assistant') return undefined;
  const message = ev.message && typeof ev.message === 'object' && !Array.isArray(ev.message)
    ? ev.message as Record<string, unknown>
    : {};
  return message.stop_reason === 'end_turn';
}

export function truncate(s: string, n: number): string {
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
export function summarizeToolUse(name: string, input?: Record<string, unknown>): string {
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
export function arrowToolUse(name: string, input?: Record<string, unknown>): string {
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

export interface NormalizedClaudeBlock {
  block: ActivityBlock;
  raw: string | null;
  sidecarPath?: string;
}

/**
 * What a text-free tool result says, one line per item it carried.
 *
 * An MCP answer is often a list of `tool_reference` items whose `tool_name` IS the
 * content, so those are named; anything else contributes its own `type`, which keeps
 * a result from reading as empty when it held something. The whole record stays in
 * the Raw drawer either way -- this is the folded line, not the evidence.
 */
function nonTextResultPreview(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return (content as Array<Record<string, unknown>>)
    .map((item) =>
      typeof item?.tool_name === 'string'
        ? (item.tool_name as string)
        : typeof item?.type === 'string'
          ? (item.type as string)
          : 'item',
    )
    .join('\n');
}

export function normalizeBlocks(content: unknown): NormalizedClaudeBlock[] {
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
        // A result whose content carries no text at all: an MCP answer made of
        // `tool_reference` items, an image, a call that returned nothing. It is still
        // that call's result, and classifying it as anything else costs the READER
        // their own turn. Without a `callId` it pairs with no tool call, so it takes a
        // row of its own; and a user line holding neither text nor a result is exactly
        // what the feed draws as the person's message. Measured 2026-09-10 on a live
        // thread: every MCP call put a JSON envelope on screen as though it had been
        // typed by the reader, and the bar that names the current user turn read
        // "(no text)" instead of what they had actually written.
        const useId = typeof b.tool_use_id === 'string' ? (b.tool_use_id as string) : undefined;
        out.push({
          block: {
            kind: 'tool_result',
            preview: nonTextResultPreview(b.content),
            ...(useId ? { callId: useId } : {}),
          },
          raw: stringifyForDisplay(b),
        });
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

export function assistantModel(message: Record<string, unknown>): string | undefined {
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
export function extractClaudeUsage(
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
export function extractClaudeCacheHit(usage: unknown): EventCacheHit | undefined {
  if (!usage || typeof usage !== 'object') return undefined;
  const u = usage as Record<string, unknown>;
  const input = typeof u.input_tokens === 'number' ? u.input_tokens : 0;
  const cacheCreate = typeof u.cache_creation_input_tokens === 'number' ? u.cache_creation_input_tokens : 0;
  const cacheRead = typeof u.cache_read_input_tokens === 'number' ? u.cache_read_input_tokens : 0;
  const total = input + cacheCreate + cacheRead;
  if (total <= 0) return undefined;
  return { cached: cacheRead, input: total };
}

export function timestampMs(value: unknown): number {
  if (typeof value !== 'string') return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

// Parse the `Output too large (43KB)` / `(2.1MB)` size hint inside a
// `<persisted-output>` envelope into an approximate char count, so the
// sidecar can stamp hiddenChars on the block. Returns null when the
// envelope is missing or the size is unparseable.
export function parsePersistedSize(raw: string): number | null {
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
export function persistedOutputPath(raw: string): string | null {
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
