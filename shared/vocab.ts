/* Closed vocabularies shared by the server and the extension. Kept free of
 * zod so the content script can import them without bundling a validator. */
export const TAGS = ["bug", "suggestion", "question"] as const;
export const STATUSES = ["open", "resolved"] as const;
export const ACTORS = ["user", "agent"] as const;
export const SCREENSHOT_MIMES = ["image/jpeg", "image/png"] as const;
