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
// The parts, in the order a line travels them: `codexRollouts.ts` finds the file and
// reads its tail, `codexPayloads.ts` says what a line's payload is, `codexNormalize.ts`
// turns one into blocks, and this assembles the `SourceAdapter` from them.
import type { LineResult, ParsedLine, SourceAdapter } from './transcriptTypes.ts';
import { plainEvent } from './plainActivity.ts';
import { isHarnessUserText } from '../humanTurns.ts';
import { truncate } from './codexPayloads.ts';
import { readTail } from './codexRollouts.ts';
import { normalizedLine } from './codexNormalize.ts';

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
      if (b.kind === 'text' && b.text && b.text.trim()) {
        // Codex injects the project's AGENTS.md ahead of the first real prompt, so without this
        // a session's rail snippet is the repository's instructions rather than what was asked.
        if (isHarnessUserText(b.text)) return '';
        return truncate(`→ ${b.text}`, 800);
      }
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

// Re-exported: the sqlite discovery is a Codex fact, and this is the adapter's address.
export { resolveStateDbPath } from './codexRollouts.ts';
