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
//
// The restart at the bottom is the same argv decision made again for a session that is already
// running, in the pane one of those three started; it lives here because recognising that pane is
// recognising this file's own launch script.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createTmuxSession,
  findTmuxSessionByIdentity,
  killTmuxSession,
  respawnTmuxPane,
  tmuxPaneStarts,
  tmuxSessionExists,
} from "@/terminal/tmux/tmuxSessions";
import { adoptTitleName } from "@/terminal/tmux/tmuxRelabel";
import { claudeLaunchPermissionArgs } from "@/config/configClaudeLaunch";

/**
 * The pane a session started or resumed by this sidecar is BORN in.
 *
 * Not the name it keeps. `adoptTitleName` renames it after the session's title as soon as the
 * identity stamp reads back, so `tmux list-sessions` is a list of titles rather than of uuids;
 * what this name is for is the window before that, and the case where it never happens.
 *
 * Derived from the session id because at creation the id is the only thing two callers are
 * guaranteed to agree on, and because a name unique by construction is what makes `new-session -A`
 * safe here: a second create under this name is the same session, never a different one that
 * happens to share a title. It stays the pane's name whenever the stamp cannot be proved, which is
 * what keeps `endClaudeSession` able to find a pane that carries no identity of its own.
 *
 * What makes a session survive becoming real is now the stamp rather than this name. A session
 * started here has no transcript and no catalog row, and the ordinary "watch this session" path
 * goes looking once the catalog knows the id -- it finds the pane by its stamp, which is why the
 * rename is allowed to happen at all and why it happens only after that stamp reads back. What has
 * to stay true is that the path finds the pane the session was STARTED in: a second pane opened for
 * one id is a terminal that jumps the moment the session exists, or worse, a transcript resumed
 * beside the process still writing it.
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
 * The prompt is a positional argument, which is how the CLI takes a first turn. `startClaudeSession`
 * delivers it through a file (`firstTurnFromFile`) rather than on tmux's command line, which caps
 * near 16KB, so a brief carrying quotes, parentheses or newlines -- or a whole handover -- arrives
 * as that one argument, whole.
 *
 * Every argv this file builds -- this one, the fork's and the resume's -- carries the permission
 * flags from `configClaudeLaunch.ts`, so a session opens in one mode however it was started.
 */
export function newClaudeSessionCommand(
  options: { sessionId: string; title: string; prompt?: string },
): string[] {
  const command = ["claude", ...claudeLaunchPermissionArgs, "--session-id", options.sessionId, "-n", options.title];
  if (options.prompt) command.push(options.prompt);
  return command;
}

/** The argv that reopens a stopped session in a pane, in the same mode a fresh one gets. */
export function resumeClaudeSessionCommand(sessionId: string): string[] {
  return ["claude", ...claudeLaunchPermissionArgs, "--resume", sessionId];
}

/**
 * Geometry for a pane no viewer has opened yet.
 *
 * A detached `new-session` is 80x24, and the CLI's first render is the one that lands in
 * scrollback forever -- a viewer attaching later resizes the pane but cannot reflow what was
 * already drawn. Wide enough that the opening turn reads, not so wide that it wraps oddly when a
 * narrow viewer does attach.
 */
export const UNATTENDED_COLUMNS = 120;
export const UNATTENDED_ROWS = 40;

/**
 * The pane script that hands the CLI its first turn out of a file: read it, delete it and its
 * directory, then run the command with the contents as one more argument.
 *
 * `printf x` and `${p%x}` keep the turn byte-exact, because command substitution strips trailing
 * newlines. The turn is never expanded or re-split: `"$@"` and `"${p%x}"` are quoted, so a turn full
 * of quotes, `$` and backticks arrives as the one argument it was.
 */
const FIRST_TURN_SCRIPT =
  'f=$1; shift; p=$(cat "$f" && printf x); s=$?; rm -f "$f"; rmdir "${f%/*}"; [ "$s" -eq 0 ] && exec "$@" "${p%x}"';

/**
 * `command` run with its first turn read from `file` rather than carried on tmux's command line.
 *
 * tmux sends `new-session`'s command to its server as one message and refuses any over about 16KB
 * with "command too long" (measured 2026-10-11 on tmux 3.6b: a 16,000-character command started, a
 * 20,000-character one did not). A handover runs from tens to hundreds of kilobytes, so its turn
 * cannot travel there. The CLI still gets it as its positional prompt, exactly as before; only the
 * hop through tmux changed. What bounds it now is the kernel's argv limit, which the handover
 * route checks before it gets here.
 */
export function firstTurnFromFile(command: readonly string[], file: string): string[] {
  return ["/bin/sh", "-c", FIRST_TURN_SCRIPT, "agentdesk-first-turn", file, ...command];
}

/**
 * Creates a launch pane, moving the first turn -- the command's LAST argument, when it has one --
 * into a private file the pane reads and deletes.
 *
 * Every turn goes this way, not only long ones, so there is one path to trust rather than a short
 * one that is exercised daily and a long one that is not. The file is the pane's to delete; this
 * deletes it only when tmux never started the pane that would have.
 */
async function createLaunchPane(
  session: string,
  cwd: string,
  command: string[],
  hasFirstTurn: boolean,
): Promise<void> {
  const pane = { session, cwd, columns: UNATTENDED_COLUMNS, rows: UNATTENDED_ROWS };
  if (!hasFirstTurn) {
    await createTmuxSession({ ...pane, command });
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), "agentdesk-first-turn-"));
  const file = join(directory, "turn.txt");
  try {
    await writeFile(file, command.at(-1)!, { mode: 0o600 });
    await createTmuxSession({ ...pane, command: firstTurnFromFile(command.slice(0, -1), file) });
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export interface StartedClaudeSession {
  sessionId: string;
  title: string;
  tmuxSession: string;
}

/**
 * Starts a session in its own detached pane, with nobody watching.
 *
 * The name it answers with is the one the pane ended up with, which is not always the one it was
 * created under: `adoptTitleName` renames it after the title once the stamp reads back. Reported
 * rather than re-derived, because a caller deriving it a second time would be guessing at which of
 * the two happened.
 */
export async function startClaudeSession(options: {
  cwd: string;
  sessionId: string;
  title: string;
  prompt?: string;
  /**
   * The argv to run instead of `newClaudeSessionCommand`'s, for a caller whose session is started
   * under rules of its own -- an arena contestant, confined to its worktree. It must start the
   * session at `sessionId`, and it carries no first turn: the caller types that once it is ready.
   */
  command?: string[];
}): Promise<StartedClaudeSession> {
  const pane = claudeSessionPaneName(options.sessionId);
  if (options.command) await createLaunchPane(pane, options.cwd, options.command, false);
  else await createLaunchPane(pane, options.cwd, newClaudeSessionCommand(options), Boolean(options.prompt));
  const tmuxSession = await adoptTitleName(pane, options.sessionId, options.title);
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
    ...claudeLaunchPermissionArgs,
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
 * terminal being open to watch it happen. Same geometry, same naming: born under the fork's id and
 * renamed to the fork's title once its stamp reads back.
 */
export async function startForkedClaudeSession(options: {
  cwd: string;
  sessionId: string;
  forkId: string;
  title: string;
  brief?: string;
}): Promise<StartedClaudeSession> {
  const pane = claudeForkPaneName(options.forkId);
  await createLaunchPane(pane, options.cwd, forkClaudeSessionCommand(options), Boolean(options.brief));
  const tmuxSession = await adoptTitleName(pane, options.forkId, options.title);
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

/** Why a restart did not happen, in terms the caller maps onto its own refusals. */
export type ClaudeRestartOutcome =
  | { kind: "restarted"; pane: string }
  | { kind: "no-pane" }
  | { kind: "not-ours"; session: string };

/**
 * Runs a session again in the pane it already has, under today's launch argv.
 *
 * What this exists for is the permission flags: a session started before `configClaudeLaunch.ts`
 * changed keeps the mode it was launched with until its process is replaced, and replacing it in
 * place is what keeps every viewer on the same pane rather than opening a second one.
 *
 * Only a pane this sidecar launched FOR THIS SESSION is restarted, and that is decided from the
 * pane's start command rather than from the identity stamp alone. The stamp is also written onto a
 * person's own tmux session when a viewer joins the process running there, and `respawn-pane -k`
 * on that pane would end their shell, not just the agent in it. A pane started by `startClaudeSession`,
 * the fork, or the resume path carries the session id in its own script, so a pane that does not is
 * somebody else's and is refused.
 */
export async function restartClaudeSession(
  options: { sessionId: string; cwd: string },
  tmux: ClaudePaneLookup & {
    respawn: (pane: string, cwd: string, command: readonly string[]) => Promise<void>;
  } = { stamped: findTmuxSessionByIdentity, paneStarts: tmuxPaneStarts, respawn: respawnTmuxPane },
): Promise<ClaudeRestartOutcome> {
  const launched = await launchedClaudePane(options.sessionId, tmux);
  if (launched.kind === "no-pane" || launched.kind === "not-ours") return launched;
  await tmux.respawn(launched.pane, options.cwd, resumeClaudeSessionCommand(options.sessionId));
  return { kind: "restarted", pane: launched.pane };
}

/** The two tmux reads that decide whether a session's pane is one this sidecar launched. */
export interface ClaudePaneLookup {
  stamped: (sessionId: string) => Promise<string | null>;
  paneStarts: (session: string) => Promise<{ pane: string; command: string }[]>;
}

/**
 * The pane this sidecar launched for a session, by the rule `restartClaudeSession` restarts by.
 *
 * Its own function because listing what a restart WOULD touch has to apply the same rule as the
 * restart: a list that counted a person's own pane would promise a restart the route then refuses.
 */
export async function launchedClaudePane(
  sessionId: string,
  tmux: ClaudePaneLookup = { stamped: findTmuxSessionByIdentity, paneStarts: tmuxPaneStarts },
): Promise<
  { kind: "pane"; pane: string; startCommand: string } | { kind: "no-pane" } | { kind: "not-ours"; session: string }
> {
  const session = await tmux.stamped(sessionId);
  if (!session) return { kind: "no-pane" };
  const launched = (await tmux.paneStarts(session)).find(({ command }) =>
    command.includes(sessionId) && /\bclaude\b/.test(command));
  return launched ? { kind: "pane", pane: launched.pane, startCommand: launched.command } : { kind: "not-ours", session };
}
