// A Bot session's title in two halves: a stable anchor, then what it is doing.
//
// The anchor is deterministic from the session's stored slot (`AD`, `AD 2`), spent once at
// attach and never reused, so it never collides and never moves. The bracket holds the task
// (`AD 2 (checkout flow)`), which the reader sets at launch and a Bot will later rename itself
// as its work changes. The anchor is the stable half other surfaces can hold onto while the
// bracket churns; the full title stays the `-n` name and the `/resume` title, so nothing about
// addressing changes, only what the string is made of.
//
// Both trees import this: the sidecar composes the `-n` title at launch and the panel seeds its
// dialogs from it. One home for the format, so the two cannot drift.

/** The stable half of a Bot session's title: the Bot's name for slot zero, numbered past it. */
export function stableSessionAnchor(botName: string, slot: number): string {
  const name = botName.trim();
  return slot <= 0 ? name : `${name} ${slot + 1}`;
}

/** The full title: the anchor alone, or the anchor with the task in brackets. */
export function formatBotSessionTitle(anchor: string, task: string): string {
  const label = task.trim();
  return label ? `${anchor.trim()} (${label})` : anchor.trim();
}

/** Splits a title into its anchor and its bracket task. No bracket means no task. */
export function parseBotSessionTitle(title: string): { anchor: string; task: string } {
  const match = /^(.*\S)\s+\(([^()]*)\)\s*$/.exec(title.trim());
  if (!match) return { anchor: title.trim(), task: "" };
  return { anchor: match[1]!, task: match[2]!.trim() };
}

/** Why a task label cannot be bracketed as-is, or null when it can. */
export function refuseTaskText(task: string): string | null {
  if (/[\n\r]/.test(task)) return "a session task cannot contain a line break";
  // The brackets are the format: a task carrying its own would not parse back.
  if (/[()]/.test(task)) return "a session task cannot contain parentheses";
  return null;
}

/**
 * Reads the task half out of text somebody typed, against the anchor that will prefix it.
 *
 * A trailing bracket names the task even when its anchor is stale; a bare anchor prefix is
 * stripped so an old title normalizes instead of nesting (`Chatbot extraction` seeds
 * `extraction` under `Chatbot`); anything else is the task whole. One function for the launch
 * path and the rename dialog, so both read the same way.
 */
export function taskFromText(text: string, anchor: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  const parsed = parseBotSessionTitle(trimmed);
  if (parsed.task) return parsed.task;
  if (trimmed === anchor) return "";
  if (trimmed.startsWith(anchor)) {
    const rest = trimmed.slice(anchor.length);
    // A word boundary, not a prefix: `ADX 7` is not `AD` plus a task.
    if (/^\s/.test(rest)) return rest.trim();
  }
  return trimmed;
}
