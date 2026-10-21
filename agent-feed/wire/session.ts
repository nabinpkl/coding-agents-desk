// What the catalog publishes about projects and sessions, and what a session can do.

import type { EventMode, SourceId } from "./activity.ts";
import type { ClaudeRunMode } from "./claudeSdk.ts";

// How recently a session was active, derived at read time rather than stored:
// a selected-project probe combines transcript recency with the latest bounded
// turn signal.
export type Bin = "live" | "ready" | "paused" | "cold";

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

/**
 * A session a tool started on its own rather than a person. One kind today: the
 * `security-guidance` plugin's review of a commit or a stopped turn, which saves a transcript like
 * any session and outnumbers the person's own in a busy repository.
 */
export type SessionAutomation = "security-review";

export interface ProjectSummary {
  projectPath: string;
  displayName: string;
  sourceCounts: Record<string, number>;
  sessionCount: number;
  lastEventAt: number;
  /**
   * When the reader archived this project folder, epoch ms. Absent when it is not archived.
   *
   * Every session in an archived folder reads as archived too (`SessionSummary.archivedAt`), so
   * the folder leaves every list at once, and the project list offers it back under its own fold.
   * Absent again while a session written there since the folder was archived is showing: the
   * folder is listed so that session has a row to be reached from.
   */
  archivedAt?: number;
  /**
   * The folder is a scratch chat's: one the sidecar made for a chat started with no project
   * (`StartScratchCommand`), holding that chat alone. Lists name these by what they are rather
   * than by the folder's generated name. Absent for every other folder.
   */
  scratch?: true;
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
  /**
   * When the reader archived this session, epoch ms. Absent for a session that is not archived.
   *
   * Archived is ours, not the provider's (`session-archive.json` beside `bots.json`): every surface
   * hides the row, and the project list offers it back under its own toggle. Every session in an
   * archived project folder carries the folder's time when it has none of its own, unless it was
   * written to after the folder was archived. A Bot view never carries one, because the sidecar
   * leaves archived sessions out of Bot views altogether.
   */
  archivedAt?: number;
  /**
   * Present when a tool started this session, which the lists fold into one row of their own at
   * the bottom. Absent for a session a person started.
   */
  automation?: SessionAutomation;
  /**
   * What the session said it set out to do, from the newest `<task-state>` block it opened a
   * response with. Absent until it has written one.
   *
   * The session's own report, read from its transcript: nothing asks it, and nothing renames it.
   * A fork carries its parent's block until it writes its first own one, which its first response
   * does when its brief hands it work.
   */
  taskState?: SessionTaskState;
  /**
   * How the session's latest turn stands, said to someone who may only be listening: the
   * `<spoken-status>` block its latest response closed with, or the question it is waiting on an
   * answer to. Absent while a turn is under way, and when the latest turn wrote no block.
   */
  spokenStatus?: SessionSpokenStatus;
}

/** What a spoken status line reports. `waiting` needs the person; the order is how much it matters. */
export type SpokenStatusKind = "waiting" | "failed" | "done" | "running" | "note";

export interface SessionSpokenStatus {
  /** At most four, each a short line, in the order the session wrote them. */
  lines: { kind: SpokenStatusKind; text: string }[];
  /** When the response carrying it was written, epoch ms. */
  at: number;
  /**
   * `block`: the session's own block, closing a response. `question`: the session asked the person
   * a question through a tool and is waiting on the answer; its one line is that question.
   */
  from: "block" | "question";
}

/** One `<task-state>` block: the goal, then the decisions the session wrote under it. */
export interface SessionTaskState {
  task: string;
  /** At most four, each one line. */
  lines: string[];
  /** When the response carrying it was written, epoch ms. */
  at: number;
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
  /**
   * How the fork's process runs (ADR-0143). Absent forks it the way its source last ran, so a fork
   * of an SDK session runs through the SDK too. Through the SDK, a fork from a message is cut there
   * when it starts, so it has no rewind to fail.
   */
  claudeMode?: ClaudeRunMode;
}

/**
 * Starting a session that belongs to nobody, in a directory the reader picked.
 *
 * The third way a session comes into existence, beside a Bot's launch and a fork, and the only one
 * that is not asked of something already there. Either harness, and either way it runs in a tmux
 * pane from its first moment: Claude because a Claude session IS a pane, opencode because its TUI
 * is started beside the serve's session rather than on the first terminal that joins it.
 */
export interface StartSessionCommand {
  source: "claude" | "opencode";
  /** Where it runs. A directory this machine has, under its home, or one the catalog knows. */
  projectPath: string;
  /** Its name, required for the reason a fork's is: for Claude it is `-n`, the session's address. */
  title: string;
  /** Its first turn. Absent starts it idle, for a reader who will type into its pane. */
  prompt?: string;
  /**
   * How a Claude session's process runs: the terminal UI (the default) or the Agent SDK runner
   * (ADR-0143). Refused for opencode, which has its own serve.
   */
  claudeMode?: ClaudeRunMode;
}

/**
 * Starting a chat with no project: the sidecar makes it a folder of its own, names it from the
 * message, and starts a Claude session through the Agent SDK with the scratch brief ahead of the
 * message (`withScratchBrief`). Nothing exists before this is sent, and a start that fails leaves
 * no folder behind.
 */
export interface StartScratchCommand {
  /** What the person typed. Required: the chat is started by its first message. */
  prompt: string;
}

/** What `StartSessionCommand` started: the session, and which harness it is running in. */
export interface StartedSourceSession extends StartedSession {
  source: StartSessionCommand["source"];
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
