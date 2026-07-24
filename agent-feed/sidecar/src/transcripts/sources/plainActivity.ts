import type { ActivityBlock, ParsedLine } from './transcriptTypes.ts';

export const PLAIN_PREVIEW_MAX_BYTES = 64 * 1024;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function stringifyForDisplay(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    const json = JSON.stringify(value, null, 2);
    return json === undefined ? String(value) : json;
  } catch {
    return String(value);
  }
}

export function boundedPlainPreview(value: unknown): string {
  const text = stringifyForDisplay(value);
  const bytes = encoder.encode(text);
  if (bytes.length <= PLAIN_PREVIEW_MAX_BYTES) return text;
  const kept = decoder.decode(bytes.slice(0, PLAIN_PREVIEW_MAX_BYTES));
  const omitted = bytes.length - PLAIN_PREVIEW_MAX_BYTES;
  return `${kept}\n\n[${omitted.toLocaleString()} UTF-8 bytes omitted; open Raw JSON for the complete record]`;
}

export function plainBlock(value: unknown): ActivityBlock {
  return { kind: 'plain', label: 'Plain', text: boundedPlainPreview(value) };
}

export function metadataBlock(label: string, text?: string): ActivityBlock {
  return { kind: 'metadata', label, ...(text ? { text } : {}) };
}

export function rawBlock(): ActivityBlock {
  return { kind: 'raw', label: 'Raw JSON' };
}

export function plainEvent(line: string, ts = 0): ParsedLine {
  return { ts, type: 'system', blocks: [plainBlock(line), rawBlock()] };
}

export function metadataText(value: unknown, maxChars = 4096): string {
  const text = stringifyForDisplay(value).trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}…`;
}
