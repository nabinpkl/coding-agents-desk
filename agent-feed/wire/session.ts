// What the catalog publishes about projects and sessions, and what a session can do.

import type { EventMode, SourceId } from "./activity.ts";

// How recently a session was active, derived at read time rather than stored:
// a selected-project probe combines transcript recency with the latest bounded
// turn signal.
export type Bin = 'live' | 'ready' | 'paused' | 'cold';

export type AgentRunState = "idle" | "running" | "ended" | "error";

export interface AgentQueueState {
  steer: number;
  followUp: number;
}

export interface AgentSessionCapabilities {
  modes: EventMode[];
  canSend: boolean;
  canSteer: boolean;
  canAbort: boolean;
  canFetchRaw: boolean;
  canOpenTerminal: boolean;
  supportsExtensionUi: boolean;
  /** True when the session has a live, network-observed delta stream (claude live source). */
  canStreamLive: boolean;
}

export interface ProjectSummary {
  projectPath: string;
  displayName: string;
  sourceCounts: Record<string, number>;
  sessionCount: number;
  lastEventAt: number;
}

export interface SessionSummary {
  sessionId: string;
  source: SourceId;
  title: string;
  lastEventAt: number;
  activity: Bin;
  capabilities: AgentSessionCapabilities;
  /**
   * The git worktree this session is working in, when that is not the directory it is listed under.
   *
   * Present only where it changes what a row means. A Bot is bound to one directory and now accepts
   * sessions from worktrees of it, so two rows on one Bot can be editing two branches of one
   * repository -- and without this they are indistinguishable, which is a worse failure than the
   * refusal that used to stand in its place.
   *
   * `branch` is null for a detached worktree, which is a real state rather than an error: a
   * worktree checked out at a commit belongs to its repository and has no branch to name.
   */
  worktree?: { path: string; branch: string | null };
}

/**
 * A session this call brought into existence, and where to watch it.
 *
 * The answer to every launch, whichever endpoint asked. It carries the pane rather than leaving
 * the caller to derive one, because the naming rule is the sidecar's (`claudeSessionPaneName`) and
 * a panel that rebuilt it would be a second copy of a decision that has to agree exactly: a viewer
 * that computes a different name opens a second pane and resumes the transcript beside the process
 * still writing it.
 */
export interface StartedSession {
  sessionId: string;
  title: string;
  /** Where it is running: the session's own directory, or the worktree that was made for it. */
  projectPath: string;
  /** The tmux session it runs in, which `TmuxTerminalContext` attaches to. */
  tmuxSession: string;
  /**
   * Why the fork could not be moved back to the message it was asked to start from.
   *
   * Absent when it was, and when none was asked for. The session EXISTS either way, which is the
   * reason this is a field rather than an error: the fork is running, holding its source's whole
   * context instead of the slice that was wanted, and a caller told only "it failed" would have no
   * idea there was now a session to deal with.
   */
  rewindFailed?: string;
}

/**
 * Branching one session into another, addressed by the session being branched.
 *
 * A fork is a SESSION operation. It used to be reachable only through a Bot, which meant a session
 * could be forked exactly when somebody had already curated it onto one -- and the transcript
 * view, where a reader actually decides to branch, has no Bot to hang it on.
 */
export interface ForkSessionCommand {
  /**
   * The fork's name, required rather than defaulted.
   *
   * `-n` sets the session's ADDRESS as well as its title, so this is the name every other agent
   * finds the fork by from its first moment. There is no second chance to set it and no sensible
   * default: a fork silently named after its source is indistinguishable from its source in every
   * listing.
   */
  title: string;
  /**
   * The fork's first turn, delivered after a standing note saying whose context it is holding.
   *
   * Absent is not an empty default. A fork opened with no prompt is a reader branching a session
   * to type into it themselves, and an injected first turn there spends a turn answering nobody.
   */
  prompt?: string;
  /**
   * Run it in a new git worktree of the session's repository rather than in the repository itself.
   *
   * `branch` defaults to a slug of the fork's title. The sidecar chooses the DIRECTORY and does not
   * take one: a path arriving over HTTP is a path this sidecar would then create a checkout at.
   */
  worktree?: { branch?: string };
  /**
   * Start the fork just BEFORE one of the source's messages, rather than holding all of it.
   *
   * `eventId` is the id the transcript page gave that row (`claude:<id>:at:<byte>`), and it
   * has to name a message a person wrote -- the picker this drives lists nothing else.
   *
   * Best effort by construction, and the response says so. The session is started first and then
   * asked to rewind itself, because there is no flag that starts one part-way through: `/rewind`
   * takes no argument and has no non-interactive mode, so it is driven in the fork's own pane
   * after it is up. A fork whose rewind did not happen is still a fork, and `rewindFailed` is how
   * the caller finds out it holds more than it asked for.
   */
  from?: { eventId: string };
}

/**
 * The newest message a person wrote in a session, addressed the way a transcript row is.
 *
 * Answered by the sidecar rather than counted in the panel, for the reason `messageAnchor.ts`
 * gives: a transcript line is a tool result, an attachment, a title record or a person speaking,
 * and which is which is one rule with one home. The surfaces that ask are the second reason -- a
 * closed card and a roster row hold no transcript at all, so there is nothing there to count.
 */
export interface LastSessionMessage {
  /** The row's id, `claude:<sessionId>:at:<position>`, exactly as `ForkSessionCommand.from` takes it. */
  eventId: string;
  /** The row's index: the byte its line starts at, which a page `around` it lands on (ADR-0125). */
  index: number;
  /** What it says, which is what the fork offers back to be edited. */
  text: string;
}
