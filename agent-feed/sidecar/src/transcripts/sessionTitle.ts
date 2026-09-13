/**
 * What counts as a session title, in one place, because two paths now accept one from a reader.
 *
 * Renaming a session and naming a fork ask the same question and used to answer it separately --
 * rename validated, the fork did not, because the fork's title was derived rather than typed. Now
 * that a fork is named in a dialog, both take a string somebody typed and both hand it to the
 * Claude CLI on a command line, so a rule that held for one and not the other would be a hole
 * rather than a difference.
 *
 * Returns the reason it is not a title, or null when it is. A reason rather than a thrown error so
 * each caller keeps its own error type and its own status code.
 */
import { SUMMARY_TITLE_CHARACTERS } from "./transcriptCatalog.ts";

export function sessionTitleRefusal(title: string): string | null {
  if (!title) return "a session title cannot be empty";
  // The catalog's own cap, not a second one: a longer title would be stored and then read back
  // truncated, so the row would not say what the reader typed.
  if (title.length > SUMMARY_TITLE_CHARACTERS) {
    return `a session title cannot exceed ${SUMMARY_TITLE_CHARACTERS} characters`;
  }
  // `/rename` takes its title to the end of one line, so a line break would end the command early
  // and leave the rest sitting in the composer as text. A fork's `-n` survives the break as an
  // argument and carries it into the session name instead, which is no better.
  if (/[\n\r]/.test(title)) return "a session title cannot contain a line break";
  return null;
}
