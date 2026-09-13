/**
 * Text of one Claude `thinking` content block, or '' when it carries none.
 *
 * One authoritative home, for the same reason as `extractReasoningText` on the
 * Codex side: the renderer decides between a reasoning block and a Plain dump, and
 * the line classifier decides whether the line is content at all. If those two
 * scans disagree, a reasoning trace with real prose gets classified as machinery
 * and disappears from the nice view with nothing to notice it from.
 *
 * The empty case is common and load-bearing: 587 of the 4,297 rows in this
 * project's largest Claude transcript (14%) are assistant lines whose only content
 * is a `thinking` block with `thinking: ""` and a long opaque `signature`. Those
 * are still `reasoning` blocks (classified by type, not by text), so the panel
 * renders them collapsed instead of dumping the signature blob -- Claude's exact
 * counterpart to Codex's encrypted reasoning items.
 */
export function thinkingText(block: Record<string, unknown>): string {
  if (block?.type !== 'thinking') return '';
  return typeof block.thinking === 'string' ? block.thinking.trim() : '';
}

/**
 * Whether a message's content is entirely reasoning that carries no readable
 * trace.
 *
 * False for empty or non-array content, and false the moment any entry is
 * something other than a traceless `thinking` block -- a line that also holds
 * prose or a tool call is content no matter what else rides along.
 */
export function isTracelessThinking(content: unknown): boolean {
  if (!Array.isArray(content) || content.length === 0) return false;
  return content.every(
    (entry) =>
      entry !== null &&
      typeof entry === 'object' &&
      !Array.isArray(entry) &&
      (entry as Record<string, unknown>).type === 'thinking' &&
      thinkingText(entry as Record<string, unknown>) === '',
  );
}
