// The curated Bot roster. A Bot owns one existing project directory first;
// provider sessions from that directory can then be attached to its projection.

import type { SourceId } from "./activity.ts";
import type { SessionSummary } from "./session.ts";

export type BotGrant = "add_bot";

export interface BotSessionRef {
  source: SourceId;
  sessionId: string;
}

export interface BotDirectoryEnvironment {
  kind: "directory";
  path: string;
}

export interface BotMetadata {
  role?: string;
  description?: string;
  labels: string[];
  custom: Record<string, string>;
}

export type BotCreatedBy =
  | { kind: "user" }
  | { kind: "bot"; botId: string };

export interface BotRecord {
  botId: string;
  name: string;
  /** An https image URL. The panel renders initials when absent or unavailable. */
  iconUrl?: string;
  environment: BotDirectoryEnvironment;
  sessionRefs: BotSessionRef[];
  metadata: BotMetadata;
  grants: BotGrant[];
  createdAt: number;
  createdBy: BotCreatedBy;
}

export interface BotView extends BotRecord {
  environmentAvailability: "available" | "missing";
  /** Current catalog summaries for the attached references that still resolve. */
  sessions: SessionSummary[];
  /** Durable references retained when their catalog session is no longer available. */
  missingSessionRefs: BotSessionRef[];
}

export interface BotSnapshot {
  version: 2;
  revision: number;
  bots: BotView[];
}

/**
 * Starting a session that works in a Bot's directory.
 *
 * A Bot is a directory plus the sessions working in it, and starting one of those is the Bot's
 * business rather than a terminal's. It used to be a terminal's: `POST /api/terminals` grew two
 * contexts that named a session which did not exist yet and brought it into being as a side effect
 * of attaching a viewer to it. That resource is an attachment capability, and the tell that the
 * verb was wrong is that its response had to report what the request had accidentally created --
 * first a process, and later a git branch and a directory on disk.
 *
 * So creation lives here, on the Bot, and a terminal went back to attaching to things that exist.
 * The caller starts a session and is told the pane it runs in; opening that pane is a second call
 * with no side effects, which is what makes it safe to make twice.
 */
export interface BotLaunchCommand {
  /** The session's name and title. Defaults to the Bot's name. */
  title?: string;
  /**
   * The session's first turn, delivered as the CLI's prompt argument.
   *
   * Text rather than a file, in both senses: a short instruction is typed here directly, and a
   * brief that lives in a file is read by whoever is calling. The sidecar deliberately does not
   * open a path handed to it over HTTP -- that is a file-read primitive on an API whose only
   * boundary is the tailnet, bought for something every caller can already do.
   *
   * A forked session gets this after a standing handoff note saying whose context it is holding;
   * see `startForkedClaudeSession`. A fresh session gets it verbatim, because it has no parent to
   * be confused with.
   */
  prompt?: string;
  /**
   * Fork this session instead of starting an empty one.
   *
   * Must be a session already attached to this Bot: forking is "give me a session that starts
   * where this one is", and the Bot is what says which sessions those are. Absent starts fresh in
   * the Bot's directory.
   *
   * Refused when creating a Bot, which has no sessions of its own to branch from yet.
   */
  from?: BotSessionRef;
  /**
   * Run it in a NEW git worktree of the Bot's repository, rather than in the repository itself.
   *
   * Two agents in one checkout share an index, a `git status` and every uncommitted file, which is
   * survivable while they are doing the same thing and is not the moment they are not. `branch`
   * defaults to a slug of the session's title.
   *
   * The sidecar chooses the DIRECTORY and does not take one: a path arriving over HTTP is a path
   * this sidecar would then create a checkout at, and where worktrees go is a decision worth
   * having exactly once.
   */
  worktree?: { branch?: string };
}

/** A session this call brought into existence, and where to watch it. */
export interface StartedBotSession {
  sessionId: string;
  title: string;
  /** Where it is running: the Bot's directory, or the worktree that was made for it. */
  projectPath: string;
  /** The tmux session it runs in, which `TmuxTerminalContext` attaches to. */
  tmuxSession: string;
}

export interface AddBotCommand {
  requestId: string;
  name: string;
  iconUrl?: string;
  /** Must exactly name an existing AgentDesk project directory. */
  directoryPath: string;
  /** Start a tmux-backed Claude session in that directory and attach it to the new Bot. */
  launch?: BotLaunchCommand;
  metadata?: {
    role?: string;
    description?: string;
    labels?: string[];
    custom?: Record<string, string>;
  };
  /** Only the authenticated user API may grant management capabilities. */
  grants?: BotGrant[];
}

/**
 * Adds a session to a Bot: one that already exists, one this call starts, or both.
 *
 * One resource for both because they are one act from the reader's side -- put a session on this
 * Bot -- and splitting them produced the shape this replaced, where creating a session meant
 * asking a different subsystem for a terminal.
 */
export interface AddBotSessionsCommand {
  requestId: string;
  /** Sessions that already exist, in the Bot's directory or a git worktree of it. */
  sessionRefs?: BotSessionRef[];
  /** A session to start in that directory and attach. */
  launch?: BotLaunchCommand;
}

/** `POST /api/bots/:botId/sessions` response. */
export interface BotSessionsAdded {
  bot: BotView;
  /** Present when this call started something. The caller has nowhere else to read it from yet. */
  started?: StartedBotSession;
}

/**
 * Removes references from a Bot's projection. The sessions themselves are untouched: a Bot is a
 * curated view over transcripts it does not own, so detaching is forgetting, not deleting.
 *
 * Same fields as attaching, and deliberately not the same type. Attaching resolves every reference
 * against the live catalog, because a Bot may only claim sessions from its own directory; detaching
 * must NOT, or a session that has gone missing would be the one thing that can never be removed --
 * and those are exactly the ones a viewer wants gone.
 */
export interface DetachBotSessionsCommand {
  requestId: string;
  sessionRefs: BotSessionRef[];
}

/**
 * Retires sessions: ends them, forgets them, and disposes of what their launch created.
 *
 * The inverse of `BotLaunchCommand`. Starting a session in a worktree is one call; tearing one
 * down was six separate acts -- end the pane, detach the reference, remove the worktree, delete the
 * branch, delete it on the remote, prune -- which is the kind of sequence that gets done three
 * times out of four and leaves a directory nobody remembers making.
 *
 * Every disposal defaults to KEEP. A caller that says nothing gets the session ended and forgotten
 * and nothing on disk touched, because the destructive half is the half worth naming out loud.
 * `remote` is separate from `branch` for the same reason one step further out: a deleted local
 * branch still exists in every clone that has it, and a deleted remote branch reaches all of them
 * at once.
 *
 * The two combinations that are refused rather than silently reinterpreted, because allowing them
 * would make this shape lie about what it does:
 *
 * - `branch: "delete"` requires `worktree: "remove"`. Git will not delete a branch that a worktree
 *   has checked out, so the pair that keeps the worktree can never delete the branch.
 * - `remote: "delete"` requires `branch: "delete"`. The local `git branch -d` is the only check
 *   that the branch is merged; deleting the remote copy without it removes the one guard, and it
 *   is the guard on the copy that is hardest to get back.
 */
export interface RetireBotSessionsCommand {
  requestId: string;
  sessionRefs: BotSessionRef[];
  /** Remove the git worktree the session was working in. Only ever a worktree of the Bot's own. */
  worktree?: "remove" | "keep";
  /** Delete the branch that worktree had checked out, once the worktree is gone. */
  branch?: "delete" | "keep";
  /** Delete that same branch on the remote it tracks. */
  remote?: "delete" | "keep";
}

/**
 * What retiring one session actually did.
 *
 * Every field records what HAPPENED rather than what was asked for, and `failed` carries the gap
 * between the two. Partial success is the ordinary outcome here rather than an edge case: a branch
 * git will not delete still leaves a pane ended and a worktree removed, and a caller told only
 * that the call failed cannot tell which of the remaining steps it now has to do by hand.
 */
export interface RetiredBotSession extends BotSessionRef {
  /** The tmux pane that was ended. Absent when there was none, which is the ordinary case. */
  endedPane?: string;
  removedWorktree?: string;
  deletedBranch?: string;
  /** The remote the branch was deleted from, present only when it was. */
  deletedRemoteBranch?: string;
  /** Asked for, and did not happen. Empty when everything asked for ran. */
  failed: { step: "pane" | "worktree" | "branch" | "remote"; reason: string }[];
}

/** `POST /api/bots/:botId/sessions/retire` response. */
export interface BotSessionsRetired {
  bot: BotView;
  /**
   * One entry per session retired, in the order asked. Empty on a replayed `requestId`, which
   * ends and removes nothing: none of the acts above is idempotent on its own.
   */
  retired: RetiredBotSession[];
}
