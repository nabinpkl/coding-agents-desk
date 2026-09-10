// Starting a Claude session in a tmux pane this sidecar owns.
//
// There are three callers and they must not disagree. The panel's new-session terminal starts one
// because a reader asked for a pane; the Bot roster starts one because a Bot is being created
// around a directory; the fork starts one because a reader branched a session that already exists.
// All three need the same decisions -- which pane name, which argv, and the identity stamp that
// survives a rename -- and the pane name in particular is not cosmetic: a session started in a
// pane named anything else is one the card's terminal will not join, so opening it would resume
// the transcript a second time beside the process still writing it.
//
// A fork differs from the other two in exactly one way, and it is the reason its argv lives here
// rather than being assembled at its call site: it inherits a context it did not build. Everything
// else about it -- the pane, the quoting, the stamp -- is the same problem solved once.

import {
  createTmuxSession,
  findTmuxSessionByIdentity,
  killTmuxSession,
  stampTmuxSessionIdentity,
  tmuxSessionExists,
} from "@/terminal/tmuxSessions";

/**
 * The pane a session started or resumed by this sidecar runs in.
 *
 * Derived from the session id rather than the title, because it is the meeting point of two
 * lookups that never speak: a second viewer of one session has only the id, and must land on the
 * pane the first one made. The friendly names in `tmuxSessionNames.ts` are for panes a person
 * types at; this one is addressed by machines.
 *
 * It is also what makes a session survive becoming real. A session started here has no transcript
 * and no catalog row, and the ordinary "watch this session" path goes looking for a pane by this
 * name once the catalog knows the id -- so the pane it was started in is the pane that path finds.
 * Give it a name of its own and the card's terminal jumps to a second pane the moment the session
 * exists, or worse, resumes the transcript beside the process still writing it.
 */
export function claudeSessionPaneName(sessionId: string): string {
  return `agentdesk-${sessionId}`;
}

/**
 * The argv that starts a fresh Claude session at a known id.
 *
 * `--session-id` stands alone, without `--resume` (measured against the CLI's own help on
 * 2026-09-08). It is what makes the transcript land at an id the caller already knows, which is
 * the only way to recognise the session before its first turn has written anything.
 *
 * `-n` sets the ADDRESS as well as the title: it is written to the session registry as `name`,
 * which is what other agents can send to. A session started without one is indistinguishable
 * from every other in a listing.
 *
 * The prompt is a positional argument, which is how the CLI takes a first turn. It goes through
 * the same per-argument shell quoting as everything else on this path (`newSessionArgs`), so a
 * brief carrying quotes, parentheses or newlines arrives whole.
 */
export function newClaudeSessionCommand(
  options: { sessionId: string; title: string; prompt?: string },
): string[] {
  const command = ["claude", "--session-id", options.sessionId, "-n", options.title];
  if (options.prompt) command.push(options.prompt);
  return command;
}

/**
 * Geometry for a pane no viewer has opened yet.
 *
 * A detached `new-session` is 80x24, and the CLI's first render is the one that lands in
 * scrollback forever -- a viewer attaching later resizes the pane but cannot reflow what was
 * already drawn. Wide enough that the opening turn reads, not so wide that it wraps oddly when a
 * narrow viewer does attach.
 */
const UNATTENDED_COLUMNS = 120;
const UNATTENDED_ROWS = 40;

export interface StartedClaudeSession {
  sessionId: string;
  title: string;
  tmuxSession: string;
}

/**
 * Starts a session in its own detached pane, with nobody watching.
 *
 * The stamp is best effort for the same reason it is on the terminal path: it makes the pane
 * findable after a rename, and a session that is running is worth more than one refused because
 * its label could not be written.
 */
export async function startClaudeSession(options: {
  cwd: string;
  sessionId: string;
  title: string;
  prompt?: string;
}): Promise<StartedClaudeSession> {
  const tmuxSession = claudeSessionPaneName(options.sessionId);
  await createTmuxSession({
    session: tmuxSession,
    cwd: options.cwd,
    command: newClaudeSessionCommand(options),
    columns: UNATTENDED_COLUMNS,
    rows: UNATTENDED_ROWS,
  });
  await stampTmuxSessionIdentity(tmuxSession, options.sessionId).catch(() => {});
  return { sessionId: options.sessionId, title: options.title, tmuxSession };
}

/**
 * The pane a fork runs in.
 *
 * Named after the fork rather than the session it branched from, which is the one thing that keeps
 * two forks of one session from landing in one pane -- and re-opening a fork from landing back in
 * the transcript the reader asked to branch away from.
 */
export function claudeForkPaneName(forkId: string): string {
  return `agentdesk-fork-${forkId}`;
}

/**
 * What a fork is told before it is told anything else.
 *
 * A fork wakes up holding another session's context and no way to tell that it is holding it. Its
 * transcript reads as its own work, mid-task, with the parent's next step implied by everything
 * above -- and the parent is still running, still holding those files, still going to finish it. So
 * the failure this exists to prevent is not confusion, it is DUPLICATION: two sessions completing
 * the same edit, on one branch, neither knowing the other is there.
 *
 * The second half is the part that is easy to leave out and expensive to omit. Saying "you are a
 * fork" is not enough, because a fork that knows it is a fork still has the parent's unfinished
 * work in front of it and no instruction to leave it alone.
 */
export const FORK_HANDOFF_PREAMBLE =
  `You are a fork of the session whose context you are holding.

Everything above this turn is that session's work, not yours. You did not start it, and the
session it came from is still running and still has it.

What follows is your task. It may continue that work, extend it, or sit beside it as a sibling of
it. Whichever it is, it is now the whole of what you are doing. Do not pick up what the parent was
in the middle of, do not finish it, and do not edit the files it is holding -- the parent is
handling that. Take the instruction below as yours alone.`;

/**
 * The preamble and the caller's brief, as one first turn.
 *
 * Composed here rather than by the caller so that every fork started through this sidecar carries
 * the same statement. A caller free to write its own would eventually write a shorter one.
 */
export function forkFirstTurn(brief: string): string {
  return `${FORK_HANDOFF_PREAMBLE}\n\n---\n\n${brief.trim()}`;
}

/**
 * The argv that forks an existing session into a new one at a known id.
 *
 * `--session-id` is accepted alongside `--fork-session` and the fork's transcript lands at exactly
 * that uuid, which is what lets a caller name a fork before it exists and find its file afterwards
 * without searching. Measured 2026-09-07; re-measured 2026-09-09 with a positional prompt on the
 * same command line, which arrives as the fork's first turn with the source's context already
 * loaded.
 *
 * The brief is optional and its absence is not a default to fill in. A fork opened with no brief is
 * a reader branching a session to type into it themselves, and a first turn injected there would
 * spend a turn answering nobody. So the preamble rides WITH a brief rather than alone: there is no
 * way to say "you are a fork" to a session that has not been given anything to do without also
 * making it do something.
 */
export function forkClaudeSessionCommand(
  options: { sessionId: string; forkId: string; title: string; brief?: string },
): string[] {
  const command = [
    "claude",
    "--resume",
    options.sessionId,
    "--fork-session",
    "--session-id",
    options.forkId,
    "-n",
    options.title,
  ];
  if (options.brief) command.push(forkFirstTurn(options.brief));
  return command;
}

/**
 * Forks a session into its own detached pane, with nobody watching.
 *
 * The sibling of `startClaudeSession`, and the answer to "fork this and hand it a brief" without a
 * terminal being open to watch it happen. Same stamp, same geometry, same best-effort reasoning:
 * a fork that is running is worth more than one refused because its label could not be written.
 */
export async function startForkedClaudeSession(options: {
  cwd: string;
  sessionId: string;
  forkId: string;
  title: string;
  brief?: string;
}): Promise<StartedClaudeSession> {
  const tmuxSession = claudeForkPaneName(options.forkId);
  await createTmuxSession({
    session: tmuxSession,
    cwd: options.cwd,
    command: forkClaudeSessionCommand(options),
    columns: UNATTENDED_COLUMNS,
    rows: UNATTENDED_ROWS,
  });
  await stampTmuxSessionIdentity(tmuxSession, options.forkId).catch(() => {});
  return { sessionId: options.forkId, title: options.title, tmuxSession };
}

/**
 * Ends the pane a session runs in, and says which pane that was.
 *
 * The mirror of the two starters above, and it lives beside them because the thing it has to get
 * right is their pane naming: a session is addressed by the name it was started under, and only
 * this file knows what that is.
 *
 * `null` when nothing was running. Retiring a session that has already finished is the ordinary
 * case rather than the surprising one, so it is an answer and not a failure.
 *
 * The stamp is asked first because it is what survives a rename -- `renameTmuxSessionTo` moves the
 * pane's name and leaves the identity option alone, so a pane a person renamed is findable only
 * this way. The two derived names are the fallback for the opposite gap: the stamp is written
 * best-effort at launch (`.catch(() => {})` above, deliberately, because a session that is running
 * beats one refused over a label), so a correctly named pane can be carrying no stamp at all.
 *
 * See `killTmuxSession` for why sending `kill-session` here does not contradict the rule in
 * `tmuxAttachment.ts` that says never to send it.
 */
export async function endClaudeSession(options: { sessionId: string }): Promise<string | null> {
  const { sessionId } = options;
  const stamped = await findTmuxSessionByIdentity(sessionId);
  // Both derived names, because this file starts sessions under two of them and the registry does
  // not record which: a fork's pane is named for the fork, a fresh session's for the session.
  const candidates = stamped
    ? [stamped]
    : [claudeSessionPaneName(sessionId), claudeForkPaneName(sessionId)];
  for (const session of candidates) {
    if (!await tmuxSessionExists(session)) continue;
    await killTmuxSession(session);
    return session;
  }
  return null;
}
