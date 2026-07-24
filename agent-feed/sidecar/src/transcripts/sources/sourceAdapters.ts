// Adapter registry. The watcher iterates `adapters` to drive per-source
// discovery, watch attach, and tail processing. Callers resolve a specific
// adapter via `adapterFor(session.source)` so a Codex session uses the Codex
// parser without source-branching at the call site.
import type { SourceAdapter, SourceId } from './transcriptTypes.ts';
import { claudeAdapter } from './claudeTranscript.ts';
import { codexAdapter } from './codexTranscript.ts';

export const adapters: SourceAdapter[] = [claudeAdapter, codexAdapter];

const byId = new Map<SourceId, SourceAdapter>(adapters.map((a) => [a.id, a]));

export function adapterFor(id: SourceId): SourceAdapter {
  const a = byId.get(id);
  if (!a) throw new Error(`no adapter registered for source "${id}"`);
  return a;
}
