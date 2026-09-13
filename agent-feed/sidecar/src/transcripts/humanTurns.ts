// Which transcript events a PERSON wrote.
//
// Both harnesses record far more than prompts under `type: "user"`. Every tool result is a user
// line -- 32 of 120 events in one sampled page, and every one of them the output of something the
// agent ran. So are the harness's own envelopes: a slash command's echo and its stdout, a
// background-task notification, an injected AGENTS.md, a system reminder.
//
// This existed as an unstated assumption before it existed as a module, and it was wrong: the
// summarizer looked backwards for `type === "user"` to find where a turn began, hit the most
// recent TOOL RESULT, and summarized the two or three events after it. The digests read as
// confident because nothing in them was fabricated -- they described a real slice of the
// transcript -- but the slice was never the turn, and the model, handed a tool result labelled
// `user`, reported it as the person speaking: "the user pasted the result of commit e3b22cc".
//
// The rule is therefore about CONTENT, not about the `type` field alone: a person's message is a
// user event carrying prose that is not one of the harness's envelopes.

import type { ParsedLine } from "@/transcripts/transcriptTypes";

/**
 * Text that arrives as a user message and is not from a person.
 *
 * Every entry was observed in a real transcript rather than guessed at. They are anchored to the
 * start because each is an envelope the harness wraps around the whole message; matching loosely
 * would let a person's message about, say, `<system-reminder>` be mistaken for one.
 */
export const HARNESS_USER_PATTERNS: readonly RegExp[] = [
  // Claude: the harness's own bracketed injections.
  /^\[Request interrupted/i,
  /^\[no content/i,
  /^Caveat:/i,
  /^<local-command-caveat>/i,
  // Claude: a slash command's echo, and the output it produced. `/compact` looks exactly like a
  // person typing when read as prose, which is how a compaction notice became a "turn".
  /^<command-name>/i,
  /^<local-command-stdout>/i,
  // Claude: where a pasted image came from, written as its own user line right after the prompt
  // that carries it. Counted as a turn, it became the newest thing the reader "said", and the
  // pinned bar showed a file path in place of the words beside the image.
  /^\[Image: source:/i,
  /^<task-notification>/i,
  /^<system-reminder>/i,
  // Codex: the project's instructions, injected ahead of the first real prompt.
  /^#\s*AGENTS\.md instructions/i,
];

/** Whether a piece of user-message text came from the harness rather than a person. */
export function isHarnessUserText(text: string): boolean {
  return HARNESS_USER_PATTERNS.some((pattern) => pattern.test(text.trim()));
}

/**
 * Whether this event is a person starting a turn.
 *
 * Prose is the test. A tool result carries `tool_result` blocks and no text, so it fails on the
 * first clause; an envelope carries text and fails on the second.
 *
 * Takes a `ParsedLine` rather than a whole `ActivityEvent` because those two fields are all it
 * reads, and the second caller has only a parsed line: resolving which human turn a transcript
 * line is happens before anything has been given an index or a revision.
 */
export function isHumanTurnStart(event: ParsedLine): boolean {
  if (event.type !== "user") return false;
  for (const block of event.blocks) {
    if (block.kind !== "text") continue;
    const text = block.text?.trim();
    if (!text) continue;
    return !isHarnessUserText(text);
  }
  return false;
}
