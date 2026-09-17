/**
 * Giving a pane the name of the session running inside it, once it is safe to give up the old one.
 *
 * A pane is BORN named after its session id (`claudeSessionPaneName`) and renamed to something a
 * person can type as soon as this can prove the rename is recoverable. Both halves matter, and the
 * order between them is the whole design:
 *
 * **Why not born with the friendly name.** The id-derived name is unique by construction, which is
 * what makes `new-session -A` safe at creation -- a second create under that name is the same
 * session, never a different one that happens to share a title. It is also the fallback
 * `endClaudeSession` uses to find a pane whose stamp is missing. Choosing the friendly name at
 * creation would give up both, and would have to pick a name before knowing whether the identity
 * that replaces it can be written at all.
 *
 * **Why the stamp is read back rather than assumed.** The name stops being the identity the moment
 * it changes, so the stamp has to BE there, not merely have been asked for. Writing it is not
 * proof: `set-option` refuses the `=` exact-match prefix that `has-session` requires and fails with
 * the option silently unset (measured 2026-09-08), which is exactly the shape that leaves a pane
 * carrying neither a readable stamp nor its derived name. So the rename happens only after a read
 * finds the pane by its stamp, and a pane that cannot prove its identity keeps the name that still
 * describes it.
 *
 * The result is one invariant worth stating plainly, because every caller depends on it:
 *
 *   A pane is findable either by its stamp or by its derived name, and never by neither.
 *
 * Failure at any step returns the name the pane already has. A session that is running beats one
 * refused over a label, which is the same reasoning the stamp was best-effort under before -- what
 * changed is that the label is now attempted only where losing it costs nothing.
 */
import { uniqueTmuxSessionName } from "@/terminal/tmux/tmuxSessionNames";
import {
  findTmuxSessionByIdentity,
  listTmuxSessions,
  renameTmuxSessionTo,
  stampTmuxSessionIdentity,
} from "@/terminal/tmux/tmuxSessions";

/**
 * The four tmux acts this needs, injectable so its ordering can be tested without tmux.
 *
 * Its own object rather than four parameters because the ORDER is what is under test: that nothing
 * is renamed before a stamp reads back, and that a failure anywhere leaves the name alone.
 */
export interface TmuxRelabelDeps {
  stamp: (session: string, sessionId: string) => Promise<unknown>;
  stamped: (sessionId: string) => Promise<string | null>;
  list: () => Promise<{ name: string }[]>;
  rename: (session: string, name: string) => Promise<void>;
}

export const LIVE_RELABEL: TmuxRelabelDeps = {
  stamp: (session, sessionId) => stampTmuxSessionIdentity(session, sessionId),
  stamped: (sessionId) => findTmuxSessionByIdentity(sessionId),
  list: () => listTmuxSessions(),
  rename: (session, name) => renameTmuxSessionTo(session, name),
};

/**
 * Stamps a pane with its session, then names it after that session's title.
 *
 * Answers the name the pane ends up with, which is the caller's to report: `StartedSession` carries
 * it on the wire precisely so nobody downstream derives it a second time and disagrees.
 *
 * Its own name is excluded from the taken set. A pane being renamed in place would otherwise
 * collide with itself and take a suffix for a name that was already free.
 */
export async function adoptTitleName(
  pane: string,
  sessionId: string,
  title: string,
  deps: TmuxRelabelDeps = LIVE_RELABEL,
): Promise<string> {
  try {
    await deps.stamp(pane, sessionId);
    // The read that licenses the rename. Anything other than this pane -- null for an option that
    // did not land, another name for a stamp that belongs elsewhere -- means the derived name is
    // still the only way back to this session, so it stays.
    if (await deps.stamped(sessionId) !== pane) return pane;
    const taken = (await deps.list()).map((session) => session.name).filter((name) => name !== pane);
    const next = uniqueTmuxSessionName(title, sessionId, taken);
    if (next === pane) return pane;
    await deps.rename(pane, next);
    return next;
  } catch {
    // No tmux, a listing that failed, or a name tmux refused. The pane is running either way, and
    // it is still called something this sidecar can find.
    return pane;
  }
}
