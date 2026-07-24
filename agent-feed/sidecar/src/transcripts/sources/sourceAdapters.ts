// Parser registry used by on-demand event indexing and raw-event reads.
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
