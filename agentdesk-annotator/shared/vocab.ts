/* Closed vocabularies shared by the server and the extension. Kept free of
 * zod so the content script can import them without bundling a validator. */
/** Order is the picker's order; the first is the default. Most annotations ask for a change, so it leads. */
export const TAGS = ["change", "comment", "bug", "suggestion", "question", "info"] as const;
export const DEFAULT_TAG = TAGS[0];

/** What each tag asks an agent to do. The one definition agents read, via MCP tool text and the brief. */
export const TAG_MEANINGS: Record<(typeof TAGS)[number], string> = {
  comment: "a note that may or may not need a fix; reply to ask the user to clarify before changing anything",
  bug: "investigate the cause and fix it",
  change: "make the requested change",
  suggestion: "do not implement yet; debate it and reply with the viable approaches, their tradeoffs, and a recommendation",
  question: "answer it (resolve with the answer as the message); change nothing",
  info: "context only; take no action and leave it open",
};

export function tagGuide(): string {
  return TAGS.map((t) => `${t}: ${TAG_MEANINGS[t]}.`).join(" ");
}
export const STATUSES = ["open", "resolved"] as const;

/** CSS properties the reader can change on a picked element and preview on the page before saving. */
export const STYLE_PROPERTIES = ["font-size"] as const;
export type StyleProperty = (typeof STYLE_PROPERTIES)[number];

/** How each property is named in a comment the panel writes for the reader. */
export const STYLE_PROPERTY_LABELS: Record<StyleProperty, string> = { "font-size": "Font size" };

/**
 * A CSS pixel length the extension wrote itself, such as `14px` or `13.33px`. A previewed value is
 * held to this shape on the wire and in a stored draft, so it carries no page text.
 */
export const CSS_PIXELS = /^\d{1,4}(\.\d{1,2})?px$/;
export const ACTORS = ["user", "agent"] as const;
export const SCREENSHOT_MIMES = ["image/jpeg", "image/png"] as const;

/**
 * Where a message the panel sent is, from the hub's own vocabulary.
 *
 * The hub owns these; the annotator only displays them. `queued` is the state the moment Send
 * returns, and the rest are what the receiving session did with it, so a reader who sends to a
 * session with nobody at the keyboard sees `queued` rather than a failure.
 */
export const SEND_STATES = ["queued", "pushed", "delivered", "answered", "expired", "cancelled"] as const;
