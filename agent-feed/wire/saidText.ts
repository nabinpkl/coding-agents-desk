// Whether a message a person typed says something, or only runs a slash command.
//
// One rule for both ends: the panel's user bar passes over a `/compact` to the message before it,
// and the sidecar answers "the last thing you said" for a bar that has nothing loaded to look
// through. Two copies of this disagreed by construction the first time either was touched.

/**
 * A prompt that is only a slash command: `/compact`, `/rename Title`. A path such as
 * `/Users/dev/x` is prose, since the token after the slash runs into another slash.
 */
const SLASH_COMMAND = /^\/[A-Za-z][\w:-]*(\s|$)/;

/** Whether a person's message says something, rather than only running a slash command. */
export function isSaidText(text: string): boolean {
  return !SLASH_COMMAND.test(text.trim());
}
