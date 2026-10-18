/**
 * The tmux session name a Claude session's title becomes.
 *
 * The name is DISPLAY, not identity. Identity is the `@agentdesk-session` option stamped on the
 * session (`tmuxSessions.ts`), which rides through every rename, so nothing here has to be stable
 * and this file is free to produce the friendliest name it can. That split is the whole point: the
 * old scheme derived the name from the session uuid precisely BECAUSE it was the lookup key, which
 * bought stateless agreement between two viewers at the cost of a name nobody could type.
 *
 * What a name has to survive:
 *
 * - **A shell.** tmux hands its pane command to `/bin/sh -c` and this repo has already lost an
 *   evening to that: a title containing `(fork 1)` reached zsh, which read the parens as a glob
 *   qualifier and answered `invalid mode specification` instead of starting the agent. Everything
 *   outside `[a-z0-9-]` is therefore replaced rather than quoted -- quoting is still correct at the
 *   call site, but a name that needs no quoting cannot be broken by a caller that forgets.
 * - **tmux's own target syntax.** `session:window.pane` means `:` and `.` end the session name, so
 *   a name carrying either addresses something other than itself.
 * - **A human typing it.** `tmux attach -t canvas-session` is the reason this exists at all.
 */

/** Where a slug is cut. Long enough to stay recognisable, short enough to type from memory. */
const MAX_SLUG_LENGTH = 32;

/**
 * How much session uuid a collision suffix carries.
 *
 * Six hex characters, which is the same prefix length the panel already shows in a session ref, so
 * a reader who sees `canvas-session-b18b00` can match it against the id they were already reading.
 */
const SUFFIX_LENGTH = 6;

/** What an untitled session is called, so the name is never empty and never a bare suffix. */
const FALLBACK_SLUG = "session";

/**
 * A title reduced to something a shell, tmux, and a person can all hold.
 *
 * Cut on a `-` boundary where one is near the limit, so a truncated name ends on a whole word
 * rather than mid-syllable: `canvas-session-fork` reads, `canvas-session-fo` reads like a typo.
 */
export function tmuxSessionSlug(title: string): string {
  const collapsed = title
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");
  if (!collapsed) return FALLBACK_SLUG;
  if (collapsed.length <= MAX_SLUG_LENGTH) return collapsed;
  const cut = collapsed.slice(0, MAX_SLUG_LENGTH);
  // Already clean when the character the cut stopped before is a separator: the limit happened to
  // land on a word end, and trimming to the PREVIOUS boundary would throw away a whole word that
  // fit. Checked against the uncut string, because `cut` cannot see what follows it.
  if (collapsed[MAX_SLUG_LENGTH] === "-") return cut;
  const boundary = cut.lastIndexOf("-");
  // Only when the boundary is not so early that the name loses its subject.
  const trimmed = boundary >= MAX_SLUG_LENGTH / 2 ? cut.slice(0, boundary) : cut;
  return trimmed.replaceAll(/-+$/g, "") || FALLBACK_SLUG;
}

/**
 * The name this session's tmux gets, given what is already running.
 *
 * Suffixed only on an actual clash, because the suffix is noise on the common case: most titles
 * here are unique, and `canvas-session` is worth more to a reader than `canvas-session-b18b00`.
 * When it is not unique -- and it often is not, six sessions were called "Windows canvas" on one
 * night -- the id decides, so the same session keeps the same name across restarts rather than the
 * name depending on who started first.
 *
 * `taken` should NOT include this session's own current name; a caller renaming in place would
 * otherwise collide with itself and suffix a name that was already free.
 */
export function uniqueTmuxSessionName(title: string, sessionId: string, taken: Iterable<string>): string {
  const slug = tmuxSessionSlug(title);
  const used = new Set(taken);
  if (!used.has(slug)) return slug;
  const suffixed = `${slug}-${sessionId.slice(0, SUFFIX_LENGTH)}`;
  if (!used.has(suffixed)) return suffixed;
  // Two sessions whose ids share a six-character prefix, or one already wearing this name. The
  // full id is unique by construction, so this terminates rather than searching.
  return `${slug}-${sessionId}`;
}
