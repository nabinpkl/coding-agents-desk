/**
 * Which composer a session opens with, remembered across visits.
 *
 * Two backends, and they are not interchangeable:
 *
 *   `terminal` attaches an xterm to the tmux pane the session is running in and types into it.
 *   Whatever the session's own renderer draws is what you see, and every key reaches it, including
 *   the ones a text field cannot express -- ctrl-c, escape, shift-tab, the arrows a composer uses.
 *
 *   `window` drives the session's real macOS window through the desktop helper, mirroring its
 *   composer two ways. It is the richer surface where it works, and it only works where there IS a
 *   window and a helper: not for a session in a terminal, and not on another machine.
 *
 * `terminal` is the default because it is the one that degrades honestly. A machine with no helper
 * reported `helper-unavailable` and offered a dead field, which is what the terminal backend was
 * built to replace; a session with no tmux pane falls back to the window band and says so.
 *
 * Global rather than per-session: it is a preference about how you like to type, not a property of
 * any one transcript.
 */
export type ComposerBackend = "terminal" | "window";

const STORAGE_KEY = "agent-panel.composer.backend";

export const DEFAULT_COMPOSER_BACKEND: ComposerBackend = "terminal";

export function loadComposerBackend(): ComposerBackend {
  if (typeof window === "undefined") return DEFAULT_COMPOSER_BACKEND;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    // Validated against the set rather than cast, so a stale or hand-edited value cannot select a
    // band that does not exist and leave the composer rendering nothing.
    return raw === "terminal" || raw === "window" ? raw : DEFAULT_COMPOSER_BACKEND;
  } catch {
    return DEFAULT_COMPOSER_BACKEND;
  }
}

export function storeComposerBackend(backend: ComposerBackend): void {
  try {
    localStorage.setItem(STORAGE_KEY, backend);
  } catch {
    /* storage disabled */
  }
}

/**
 * The band to actually render, which is the preference only when it can be honoured.
 *
 * Kept separate from the preference so that falling back never rewrites what the viewer asked for:
 * someone who prefers the terminal and opens a session with no pane should get the window band for
 * that session and the terminal band again for the next one.
 */
export function resolveComposerBackend(
  preferred: ComposerBackend,
  { tmuxSession }: { tmuxSession: string | null },
): ComposerBackend {
  if (preferred === "terminal" && tmuxSession) return "terminal";
  return "window";
}
