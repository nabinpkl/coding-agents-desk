/* Closed vocabularies shared by the server and the extension. Kept free of
 * zod so the content script can import them without bundling a validator. */
/** Order is the picker's order; the first is the default. */
export const TAGS = ["comment", "bug", "change", "suggestion", "question", "info"] as const;
export const DEFAULT_TAG = TAGS[0];

/** What each tag asks an agent to do. The one definition agents read, via MCP tool text and the brief. */
export const TAG_MEANINGS: Record<(typeof TAGS)[number], string> = {
  comment: "a note that may or may not need a fix; ask the user to clarify (reopen with a message) before changing anything",
  bug: "investigate the cause and fix it",
  change: "make the requested change",
  suggestion: "do not implement yet; debate it, lay out the viable approaches with their tradeoffs, and recommend one",
  question: "answer it (resolve with the answer as the message); change nothing",
  info: "context only; take no action and leave it open",
};

export function tagGuide(): string {
  return TAGS.map((t) => `${t}: ${TAG_MEANINGS[t]}.`).join(" ");
}
export const STATUSES = ["open", "resolved"] as const;
export const ACTORS = ["user", "agent"] as const;
export const SCREENSHOT_MIMES = ["image/jpeg", "image/png"] as const;
