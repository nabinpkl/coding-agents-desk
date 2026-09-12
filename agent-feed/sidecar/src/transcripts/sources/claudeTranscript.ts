// Claude adapter. Owns everything Claude-specific:
//   - transcript layout at ~/.claude/projects/<slug>/<sessionId>.jsonl
//   - per-message envelope shape (`{type, message:{content:[blocks]}}`)
//   - stop_reason → turn-boundary signals (end_turn closes the turn)
//   - tool-name vocabulary (Read/Edit/Write/Bash/Grep/Glob/...)
//
// Which user lines came from a person rather than the harness is NOT here: both sources inject
//
// The parts, in the order a line travels them: `claudeProjects.ts` finds the file and
// reads its edges, `claudePayloads.ts` says what a line carries, `claudeNormalize.ts`
// turns one into blocks, and this assembles the `SourceAdapter` from them.

import type { Header, LineResult, ParsedLine, SourceAdapter } from './transcriptTypes.ts';
import { plainEvent } from './plainActivity.ts';
import { isHarnessUserText } from '../humanTurns.ts';
import { arrowToolUse, persistedOutputPath, truncate } from './claudePayloads.ts';
import { normalizedLine } from './claudeNormalize.ts';
import { filePathToSessionId, readHeader, readSidecar } from './claudeProjects.ts';

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
        if (isHarnessUserText(b.text)) return '';
        return truncate(`→ ${b.text}`, 800);
      }
    }
  }
  return '';
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
