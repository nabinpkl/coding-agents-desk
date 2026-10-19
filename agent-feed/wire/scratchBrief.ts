// The brief a scratch chat's first message opens with, and how both ends find it again.
//
// A chat started from the panel's Chat menu has no project and no instructions file: what the
// agent is told about where it is and what it may become rides at the front of the first message,
// so it is in the transcript and survives a resume, a switch between the SDK and the terminal, and
// a handover. The sidecar wraps it on the way in and splits it back out when it turns the line
// into blocks, so every reader of "what the person said" gets only the person's words, and the
// panel folds the brief under its own label.
//
// Found by its exact opening marker at the very start of the text, never by a pattern: the brief
// always comes first, so the first closing marker after it is always the brief's own, whatever the
// person typed after it. The brief's wording can change without breaking chats written with an
// older one, because nothing here depends on it.

const OPEN = "<agentdesk-scratch-brief>";
const CLOSE = "</agentdesk-scratch-brief>";

/** The label the brief's block carries once it is split out of the message. */
export const SCRATCH_BRIEF_LABEL = "Brief";

/** The first message a scratch chat is started with: the brief, then what the person typed. */
export function withScratchBrief(brief: string, prompt: string): string {
  return `${OPEN}\n${brief.trim()}\n${CLOSE}\n\n${prompt}`;
}

/**
 * The brief and the person's words, when the text opens with a brief; null when it does not.
 *
 * A text cut short inside the brief (a capped preview) has no closing marker yet, and all of what
 * is there is brief, so the person's part is empty rather than the markup.
 */
export function splitScratchBrief(text: string): { brief: string; rest: string } | null {
  if (!text.startsWith(OPEN)) return null;
  const end = text.indexOf(CLOSE, OPEN.length);
  if (end === -1) return { brief: text.slice(OPEN.length).trim(), rest: "" };
  return { brief: text.slice(OPEN.length, end).trim(), rest: text.slice(end + CLOSE.length).trim() };
}
