import type { SessionSummary } from "@agentdesk/agent-feed-wire";

/**
 * Whether this session's row offers "Rename session".
 *
 * Two sources, and the reason is a name rather than a feature: a Claude session and an opencode
 * session each carry a title this panel can write, while a Codex session's title is a record inside
 * a transcript the panel does not write (the same reason its row offers no fork either). Offering
 * the item where it cannot work is worse than a shorter menu, so this is asked where the menu is
 * built rather than inside it.
 *
 * One answer for every surface that builds the menu -- the Bot's canvas card and the roster beside
 * it -- because two lists of renameable sources is one of them out of date within a release.
 */
export function canRenameSession(session: SessionSummary): boolean {
  return session.source === "claude" || session.source === "opencode";
}
