/**
 * Text of one Codex `reasoning` response item, or '' when it carries none.
 *
 * One authoritative home, because two callers must agree exactly: the adapter,
 * which decides whether to render a reasoning block or fall back to a Plain dump,
 * and the line classifier, which decides whether the line is content at all.
 * Two copies of this scan would drift, and the failure would be silent in the
 * worst direction -- a reasoning trace with real prose classified as machinery and
 * omitted from the nice view.
 *
 * 81,905 of this project's 91,311 reasoning items (90%) return '': Codex emits the
 * trace as `summary` only when configured to expose it, and otherwise the record
 * carries just an `encrypted_content` blob that is end-to-end encrypted and
 * unreadable here.
 */
export function extractReasoningText(payload: {
  summary?: unknown;
  content?: unknown;
}): string {
  let text = '';
  if (Array.isArray(payload.summary)) {
    const parts: string[] = [];
    for (const entry of payload.summary as unknown[]) {
      if (typeof entry === 'string') parts.push(entry);
      else if (
        entry &&
        typeof entry === 'object' &&
        typeof (entry as { text?: unknown }).text === 'string'
      ) {
        parts.push((entry as { text: string }).text);
      }
    }
    text = parts.join('\n\n').trim();
  }
  if (!text && Array.isArray(payload.content)) {
    text = joinTextContent(payload.content).trim();
  }
  return text;
}

/**
 * Concatenate the prose out of a Codex content-block array.
 *
 * Both `input_text` and `output_text` carry it in `.text`.
 */
export function joinTextContent(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content as Array<Record<string, unknown>>) {
    const kind = block?.type;
    if ((kind === 'input_text' || kind === 'output_text') && typeof block.text === 'string') {
      parts.push(block.text as string);
    }
  }
  return parts.join('\n\n');
}
