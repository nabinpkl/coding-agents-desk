/**
 * Bringing a Claude session into existence, and branching one that already exists.
 *
 * Forking used to be reachable only through a Bot: `launch.from` had to name a session the Bot
 * already held, because the Bot was what said which sessions belonged to a directory. That is a
 * true statement about Bots and the wrong place to hang the operation. A reader decides to branch
 * while READING a transcript, and the transcript view has no Bot -- so the affordance had nowhere
 * to go, and a session nobody had curated onto a Bot could not be forked at all.
 *
 * So the fork is a session operation, addressed by the session being forked, and the Bot endpoint
 * is one of its callers rather than its owner. What the Bot still decides is its own question --
 * whether the source is one of ITS sessions -- and it decides that before calling in here.
 *
 * `launchSession` below is the one path that starts a session, whichever endpoint asked. It makes
 * four decisions and they are made here, once: which directory it runs in, whether it starts empty
 * or from another session's context, what its first turn is, and which pane it lands in. They were
 * three separate mechanisms not long ago, and only one of the three made all four correctly.
 */
import type { ClaudeRunMode, ForkSessionCommand, StartedSession } from "@agentdesk/agent-feed-wire";
import { startClaudeSdkSession } from "@/claude-sdk/claudeSdkLaunch";
import { branchFromTitle, prepareWorktree, worktreeOf } from "@/git/worktree";
import {
  endClaudeSession,
  startClaudeSession,
  startForkedClaudeSession,
} from "@/terminal/session-panes/claudeSessionLaunch";
import { LIVE_FORK_REWINDER } from "@/transcripts/session-ops/forkRewind";
import {
  anchorAtPosition,
  positionFromEventId,
  MessageAnchorError,
  type MessageAnchor,
} from "@/transcripts/messageAnchor";
import { sessionTitleRefusal } from "@/transcripts/session-ops/sessionTitle";
import { findSession } from "@/transcripts/catalog/transcriptCatalog";

/**
 * How long a first turn may be.
 *
 * It becomes one argv element passed through two shells, where the ceiling is the kernel's
 * argument limit, about a megabyte -- so this is not that constraint. It is the size at which a
 * "first turn" has stopped being one: a grounding brief written by hand runs a few thousand
 * characters, and something ten times that belongs in a file the session reads for itself.
 */
export const MAX_LAUNCH_PROMPT = 32_768;
/** The cap a branch name shares with every other short name on this wire. */
const MAX_BRANCH_NAME = 64;

/** The request was malformed or the title is not one. */
export class SessionForkInvalidError extends Error {}
/** There is no such session to fork. */
export class SessionForkNotFoundError extends Error {}

/**
 * Moving a just-started fork back to the message it was asked to start from, and giving it its
 * first turn once it is there.
 *
 * One seam rather than three, because the three steps are only ever done together and the tests
 * that care about them are the picker's own. What a fork's own tests need from here is whether
 * this was attempted and what it answered.
 */
export type ForkRewinder = (options: {
  sessionId: string;
  anchor: MessageAnchor;
  prompt?: string;
}) => Promise<{ done: true } | { done: false; reason: string }>;

/**
 * How a session is actually started and ended, injectable so the decisions above can be tested
 * without tmux and without a Claude CLI.
 *
 * The two starting halves are genuinely different commands rather than one with a flag: a fresh
 * session is `--session-id`, a fork is `--resume ... --fork-session --session-id`, and the fork's
 * brief rides behind a standing handoff note that the fresh one must not get.
 *
 * Ending is on the same seam for a stronger version of the same reason. A test that started a pane
 * would need tmux; a test that ENDED one would need tmux and would be the only test here that can
 * destroy something outside its own fixture.
 */
export interface SessionLauncher {
  /** A session with no history, in `cwd`, in the terminal UI or through the SDK runner. */
  start(options: {
    cwd: string;
    sessionId: string;
    title: string;
    prompt?: string;
    mode?: ClaudeRunMode;
  }): Promise<{ tmuxSession: string }>;
  /** A session that starts where `sessionId` is, running in `cwd` under `forkId`. */
  fork(options: {
    cwd: string;
    sessionId: string;
    forkId: string;
    title: string;
    brief?: string;
  }): Promise<{ tmuxSession: string }>;
  /** Ends the pane a session runs in, answering with its name or null when there was none. */
  end(options: { sessionId: string }): Promise<string | null>;
}

/**
 * The live launcher, calling THROUGH the imports rather than holding them.
 *
 * The indirection is not style. An object literal built at module load captures whatever the
 * import named at that instant, which makes this arm unreplaceable afterwards -- and the failure
 * that produces is not a red test, it is a test that quietly starts real tmux panes and real
 * Claude processes on the machine running it. Calling the binding defers the lookup to the moment
 * of use, which is what every other module here does by simply calling its imports.
 */
export const LIVE_SESSION_LAUNCHER: SessionLauncher = {
  start: ({ mode, ...options }) => mode === "sdk" ? startClaudeSdkSession(options) : startClaudeSession(options),
  fork: (options) => startForkedClaudeSession(options),
  end: (options) => endClaudeSession(options),
};


export interface SessionLaunchPlan {
  /**
   * The repository a new worktree would be cut from.
   *
   * Not the same as where the session runs. A session already working in a worktree has to make
   * its fork's worktree from the MAIN checkout -- `git worktree add` inside a worktree still
   * belongs to the one repository, and cutting from the worktree's own path would nest them.
   */
  checkout: string;
  /**
   * Where the source session runs, when there is one.
   *
   * A fork runs where its source runs unless it asked for a tree of its own, so a fork of a
   * session already in a worktree stays in that worktree rather than being pulled back into the
   * checkout it branched away from.
   */
  sourcePath?: string;
  /** The session id to branch from. Absent starts one with no history. */
  from?: string;
  /**
   * Where in `from`'s conversation to start, when the caller named a message. Resolved by the
   * caller BEFORE this runs (`resolveMessageAnchor`), so a row that is not a message is refused
   * rather than answered with a running fork holding the whole conversation.
   */
  anchor?: MessageAnchor;
  title: string;
  prompt?: string;
  worktree?: { branch?: string };
  /** The terminal UI unless this says `"sdk"` (ADR-0143). A fork is terminal-only for now. */
  claudeMode?: ClaudeRunMode;
}

/**
 * The one path that brings a session into existence.
 *
 * Throws `WorktreeError` unmapped when git refuses the tree, because that failure belongs to git
 * and each caller says it in its own vocabulary: the Bot answers 409 as a Bot conflict, the
 * session endpoint answers 409 as a fork conflict, and neither wants the other's wording.
 */
export async function launchSession(
  plan: SessionLaunchPlan,
  launcher: SessionLauncher = LIVE_SESSION_LAUNCHER,
  newSessionId: () => string = () => crypto.randomUUID(),
  rewinder: ForkRewinder = LIVE_FORK_REWINDER,
): Promise<StartedSession> {
  // Refused before a worktree is cut, so a request that cannot be honoured leaves nothing behind.
  if (plan.from && plan.claudeMode === "sdk") {
    throw new SessionForkInvalidError("a fork starts in the terminal; SDK mode is for new sessions for now");
  }
  const cwd = plan.worktree
    ? (await prepareWorktree({
      checkout: plan.checkout,
      branch: plan.worktree.branch ?? branchFromTitle(plan.title),
    })).path
    : plan.sourcePath ?? plan.checkout;

  const sessionId = newSessionId();
  const started = plan.from
    ? await launcher.fork({
      cwd,
      sessionId: plan.from,
      forkId: sessionId,
      title: plan.title,
      // Withheld from the command line when there is a rewind coming: the CLI takes a positional
      // prompt as the first turn, and that turn would run against the whole inherited context
      // before anything had moved. It is typed into the box after the rewind instead.
      brief: plan.anchor ? undefined : plan.prompt,
    })
    : await launcher.start({
      cwd,
      sessionId,
      title: plan.title,
      prompt: plan.prompt,
      ...(plan.claudeMode === undefined ? {} : { mode: plan.claudeMode }),
    });
  const launched = { sessionId, title: plan.title, projectPath: cwd, tmuxSession: started.tmuxSession };
  if (!plan.from || !plan.anchor) return launched;

  const moved = await rewinder({
    sessionId,
    anchor: plan.anchor,
    ...(plan.prompt === undefined ? {} : { prompt: plan.prompt }),
  });
  // Reported, never thrown. The fork is running either way, and a caller told only that the
  // request failed would not know there was now a session holding more than it asked for.
  return moved.done ? launched : { ...launched, rewindFailed: moved.reason };
}

/**
 * Forks one Claude session, addressed by the session being forked.
 *
 * Claude only, and that is in the route pattern rather than in a branch here: `--fork-session` is
 * a Claude CLI flag, and Codex has `resume` with no fork, so a Codex source would be silently
 * resumed into the original transcript rather than branched from it.
 *
 * Unlike renaming, this does not need the source to be RUNNING. A fork reads the transcript the
 * source wrote; whether a process still holds it changes nothing about what the fork inherits.
 */
export async function forkClaudeSession(
  sessionId: string,
  command: ForkSessionCommand,
  launcher: SessionLauncher = LIVE_SESSION_LAUNCHER,
  newSessionId: () => string = () => crypto.randomUUID(),
  rewinder: ForkRewinder = LIVE_FORK_REWINDER,
): Promise<StartedSession> {
  const title = compact(command.title);
  const refusal = sessionTitleRefusal(title);
  if (refusal) throw new SessionForkInvalidError(`title: ${refusal}`);

  const prompt = command.prompt;
  if (prompt !== undefined) {
    if (typeof prompt !== "string") {
      throw new SessionForkInvalidError("prompt must be a string");
    }
    if (prompt.length > MAX_LAUNCH_PROMPT) {
      throw new SessionForkInvalidError(`prompt cannot exceed ${MAX_LAUNCH_PROMPT} characters`);
    }
  }
  // Trimmed at the ends only, never reshaped: the prompt is the fork's first turn and its line
  // breaks are the reader's.
  const brief = prompt?.trim() ? prompt.trim() : undefined;
  const worktree = normalizeWorktree(command.worktree);

  const source = findSession("claude", sessionId);
  if (!source || !source.transcriptPath) {
    throw new SessionForkNotFoundError(`session claude:${sessionId} is not in the catalog`);
  }

  // Resolved BEFORE anything is started, so a request naming a row that is not a message is
  // refused rather than answered with a running fork holding the whole conversation.
  const anchor = command.from === undefined
    ? undefined
    : await resolveMessageAnchor(command.from, sessionId, source.transcriptPath);

  return launchSession(
    {
      checkout: (await worktreeOf(source.project))?.mainCheckout ?? source.project,
      sourcePath: source.project,
      from: sessionId,
      ...(anchor === undefined ? {} : { anchor }),
      title,
      ...(brief === undefined ? {} : { prompt: brief }),
      ...(worktree === undefined ? {} : { worktree }),
    },
    launcher,
    newSessionId,
    rewinder,
  );
}

/**
 * Where in a session's conversation to start, for a caller that named one of its messages.
 *
 * Exported for the Bot endpoint, which forks from a message too and has to refuse the same rows
 * this does. Throws `SessionForkInvalidError` for each caller to say in its own vocabulary.
 */
export async function resolveMessageAnchor(
  from: unknown,
  sessionId: string,
  transcriptPath: string,
): Promise<MessageAnchor> {
  if (!from || typeof from !== "object" || typeof (from as { eventId?: unknown }).eventId !== "string") {
    throw new SessionForkInvalidError("from.eventId must be a string");
  }
  try {
    return await anchorAtPosition(
      sessionId,
      transcriptPath,
      positionFromEventId((from as { eventId: string }).eventId, sessionId),
    );
  } catch (error) {
    if (error instanceof MessageAnchorError) throw new SessionForkInvalidError(`from: ${error.message}`);
    throw error;
  }
}

/**
 * The worktree request, if there is one.
 *
 * The branch is optional and the sidecar derives it from the title, so `{}` is the ordinary thing
 * to send: a reader ticking a box has an opinion about isolation and none about branch names.
 */
function normalizeWorktree(value: unknown): { branch?: string } | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SessionForkInvalidError("worktree must be an object");
  }
  const raw = (value as { branch?: unknown }).branch;
  if (raw === undefined) return {};
  if (typeof raw !== "string") throw new SessionForkInvalidError("worktree.branch must be a string");
  const branch = compact(raw);
  if (!branch) throw new SessionForkInvalidError("worktree.branch cannot be empty");
  if (branch.length > MAX_BRANCH_NAME) {
    throw new SessionForkInvalidError(`worktree.branch cannot exceed ${MAX_BRANCH_NAME} characters`);
  }
  return { branch };
}

/**
 * Trimmed at the ends and nowhere else, which is what both siblings do.
 *
 * Collapsing the middle would be the wrong kind of helpful: it turns a line break into a space
 * before `sessionTitleRefusal` can see one, so the rule against a title that ends a command early
 * would silently never fire.
 */
function compact(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
