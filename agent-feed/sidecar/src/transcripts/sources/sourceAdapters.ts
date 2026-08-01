// Parser registry used by on-demand event indexing and raw-event reads.
import type { SourceAdapter, TranscriptSourceId } from './transcriptTypes.ts';
import { claudeAdapter } from './claudeTranscript.ts';
import { codexAdapter } from './codexTranscript.ts';

export const adapters: SourceAdapter[] = [claudeAdapter, codexAdapter];

const byId = new Map<TranscriptSourceId, SourceAdapter>(adapters.map((a) => [a.id, a]));

export function adapterFor(id: TranscriptSourceId): SourceAdapter {
  const a = byId.get(id);
  if (!a) throw new Error(`no adapter registered for source "${id}"`);
  return a;
}
