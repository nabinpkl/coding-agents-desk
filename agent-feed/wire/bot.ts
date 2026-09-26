// The curated Bot roster. A Bot owns one existing project directory first;
// provider sessions from that directory can then be attached to its projection.

import type { SourceId } from "./activity.ts";
import type { SessionSummary, StartedSession } from "./session.ts";
import type { WorkspaceFileKind, WorkspaceGitEntry, WorkspaceTreeNode } from "./workspaceIde.ts";

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
  /**
   * Each attached session's step on this Bot's shade ladder, by `source:sessionId`.
   *
   * Assigned once at attach and never recomputed from order, so a reorder repaints nothing, a
   * detach shifts no tail, and a reattach restores the same shade and face. Detaching keeps the
   * entry; only a never-before-attached session takes `nextSessionSlot`. Absent on records
   * written before slots existed, which read as the current `sessionRefs` order.
   */
  sessionSlots?: Record<string, number>;
  /** The next slot to hand out on this Bot. Never reused, so history cannot collide. */
  nextSessionSlot?: number;
  /**
   * Each attached session's stable anchor, by `source:sessionId`: the plain name its title starts
   * with (`Aaron` in `Aaron (checkout flow)`).
   *
   * Allocated once from the pool, first-free machine-wide, and never reused -- the same rule as
   * slots, for the same reason. Detaching keeps the entry, so a reattach restores the same name.
   * Absent on records written before anchors existed, which normalize on the next rename or
   * on the normalize-titles pass.
   */
  sessionAnchors?: Record<string, string>;
  metadata: BotMetadata;
  grants: BotGrant[];
  createdAt: number;
  createdBy: BotCreatedBy;
  /**
   * Taken off the Bot canvas. Absent means on it.
   *
   * Kept on the record rather than in the browser, so every surface and every reload reads one
   * answer and a Bot on a peer carries its own. Changed with `SetBotCanvasCommand`.
   */
  offCanvas?: boolean;
  /** This Bot's sessions taken off the canvas. Always a subset of `sessionRefs`; absent means none. */
  offCanvasSessionRefs?: BotSessionRef[];
  /**
   * Where this Bot stands on the canvas strip, left to right. A sort key rather than an index into
   * one list, because the strip spans machines and each `bots.json` holds only its own Bots: the
   * panel sorts every machine's Bots by it together. Absent until the reader first arranges the
   * strip, and a Bot without one stands after every Bot with one.
   */
  canvasPosition?: number;
  /**
   * The session that speaks as this Bot's Father, and the panel renders as its home.
   *
   * One of `sessionRefs`: the Father is a member of the Bot, not a session from elsewhere.
   * Absent means the Bot has no Father and the home stays shut. Named rather than derived
   * (newest, livest) because derivation would promote a different session every reload and the
   * home would follow it.
   */
  fatherSession?: BotSessionRef;
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
  /**
   * What the session is working on. The `-n` title is composed from it: the session's allocated
   * anchor first, this text bracketed after (`Aaron (Checkout flow)`). Omitted starts bare under
   * the anchor. The anchor is spent from the machine-wide pool at launch, so this never names it.
   */
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

export interface AddBotCommand {
  requestId: string;
  name: string;
  iconUrl?: string;
  /**
   * Must exactly name a directory this machine has: either one the catalog knows, or one under the
   * home directory the folder picker lists from. A project with no sessions in it yet qualifies --
   * that is what naming a Bot before its first turn means.
   */
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
  started?: StartedSession;
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
 * Puts a Bot's sessions in a new order. Nothing is attached and nothing is detached: this is the
 * same curation, standing differently.
 *
 * Order is the BOT's fact rather than a viewer's arrangement, which is why it is a command at all.
 * The panel ranks a Bot's session colours by this list, so a reader who rearranged it locally
 * would be looking at a card whose colours disagreed with its positions -- and nobody else would
 * see the arrangement, on this machine or any other.
 *
 * The COMPLETE order rather than a move, and refused unless it names exactly the references the
 * Bot already holds. Both halves are about the same hazard, a caller working from a roster that
 * has moved since it was read: a move by index would quietly reorder around a session attached in
 * the meantime, and a partial list would have to be interpreted -- appended, prepended, or read as
 * a detach -- when what it really says is that the caller is out of date. Stating the order in
 * full is what makes that detectable, and refusing is what stops it being guessed at.
 */
export interface ReorderBotSessionsCommand {
  requestId: string;
  /** Every reference the Bot holds, in the order it should now stand. */
  sessionRefs: BotSessionRef[];
}

/**
 * Puts a Bot, or some of its sessions, on or off the canvas, or stands it somewhere on the strip.
 *
 * A setting rather than an act, so no `requestId`: sending it twice lands the same state, and an
 * idempotency record per toggle would grow `bots.json` by one entry every click. Each field left
 * out is left as it is. A session must be one the Bot holds.
 */
export interface SetBotCanvasCommand {
  onCanvas?: boolean;
  sessions?: BotCanvasSessionChange[];
  /** The Bot's new `canvasPosition`. A nonnegative integer. */
  position?: number;
}

export interface BotCanvasSessionChange extends BotSessionRef {
  onCanvas: boolean;
}

/**
 * Renames a Bot, restyles it, or names its Father.
 *
 * A setting rather than an act, so no `requestId`, for `SetBotCanvasCommand`'s reason: sending
 * it twice lands the same record. Each field left out is left as it is, and a call naming
 * nothing is refused rather than answered as a no-op. The directory, the sessions, the grants
 * and the history are not settable: a Bot cannot become a different checkout, and only creation
 * grants management powers.
 */
export interface UpdateBotCommand {
  /** Trimmed, unique across Bots ignoring case. Empty is refused, not a clear. */
  name?: string;
  /**
   * An https image URL. Empty clears it to the initials the panel renders without one; anything
   * else must parse as https, the same rule creation obeys.
   */
  iconUrl?: string;
  /** Merged over the Bot's metadata: labels and custom entries replace wholesale per field. */
  metadata?: {
    role?: string;
    description?: string;
    labels?: string[];
    custom?: Record<string, string>;
  };
  /**
   * The session that speaks as this Bot's Father. Must be one the Bot holds -- the Father is a
   * member, not a session from elsewhere -- and null clears it. Detaching the named session
   * clears it in the same write, so no update can strand a Father the Bot no longer holds.
   */
  fatherSession?: BotSessionRef | null;
}

/** `DELETE /api/bots/:botId` response. The sessions survive: a Bot is forgotten, not ended. */
export interface BotDeleted {
  deleted: string;
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
  /** The remote branch that was deleted, as `<remote>/<branch>`, present only when it was. */
  deletedRemoteBranch?: string;
  /**
   * A remote branch the local delete left behind, as `<remote>/<branch>`. Named, never removed.
   *
   * Deleting the local branch is what makes its remote copy hard to see: nothing local points at
   * it, so it drops out of `git branch` and turns up only for somebody running `git ls-remote`.
   * Whether it should go is not this call's decision, so it says the name and stops.
   */
  orphanedRemoteBranch?: string;
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

/**
 * Renames one Bot session's bracket task, addressed by the session rather than the Bot.
 *
 * The single completion path every `set_task` front door forwards to: the relay child for
 * Claude, the hub for opencode, a native tool for Pi. The caller names the session and the task
 * text only -- the anchor is resolved here, composed here, and never arrives over this wire.
 */
export interface RenameBracketCommand {
  source: SourceId;
  sessionId: string;
  /** The bracket task. Empty starts the session bare under its anchor. */
  task: string;
}

/** `POST /api/sessions/:source/:sessionId/bracket` response. */
export interface RenamedBracket {
  botId: string;
  anchor: string;
  title: string;
  status: "renamed" | "already";
}

/**
 * `GET /api/bots/:botId/git/stream` event: what is uncommitted in the Bot's directory, sent on
 * subscribing and again after every change the sidecar's repository watch sees.
 *
 * The Bot's own route rather than the IDE's, because a Bot is a directory and not a workspace: the
 * IDE addresses a root somebody registered, and a Bot's directory usually is not one. The entries
 * are the IDE's own shape, so both surfaces draw them with one list.
 */
export interface BotGitStatus {
  botId: string;
  /**
   * False when the directory is not inside a repository. Said rather than answered as an empty
   * list, because "nothing changed" and "there is no git here" are different things to show.
   */
  repository: boolean;
  branch: string | null;
  /** Paths relative to the repository's top, which may be above the Bot's directory. */
  entries: WorkspaceGitEntry[];
}

/** `GET /api/bots/:botId/git/diff?path=` response: one changed path against `HEAD`. */
export interface BotGitDiff {
  botId: string;
  path: string;
  /** Staged and unstaged together, or the whole file as added when git does not track it yet. */
  patch: string;
  /** True when the patch was cut at the sidecar's ceiling. */
  truncated: boolean;
}

/**
 * `GET /api/bots/:botId/tree?expanded=<path>&expanded=<path>` response: the Bot's directory as the
 * IDE's explorer draws it, with every expanded directory listed beneath it.
 *
 * Expansion travels with the request rather than living on the sidecar, because it belongs to one
 * reader's glance at the Bot and not to the Bot: the IDE shares its open tabs between readers, and
 * a quick look into a Bot's code is not something a second reader should find rearranged. Paths
 * and git decorations are relative to the Bot's directory, not to the repository's top.
 */
export interface BotTree {
  botId: string;
  tree: WorkspaceTreeNode[];
}

/**
 * `GET /api/bots/:botId/file?path=` response: one file in the Bot's directory, read-only.
 *
 * The IDE's read without its workspace: text for every kind the IDE opens, null for a binary-backed
 * one, which this route has no content route beside it to fetch.
 */
export interface BotFileRead {
  botId: string;
  path: string;
  kind: WorkspaceFileKind;
  text: string | null;
}
