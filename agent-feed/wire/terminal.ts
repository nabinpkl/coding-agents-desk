/** One tmux session, as `GET /api/tmux/sessions` reports it. */
export interface TmuxSessionSummary {
  name: string;
  windows: number;
  /** Zero means nobody is looking at it right now, not that it has stopped. */
  attachedClients: number;
  /** The session's working directory, which is the closest thing it has to a project. */
  path: string;
}

/** A provider session whose CLI should be resumed inside the Agent Feed terminal. */
export interface AgentSessionTerminalContext {
  kind: "agent-session";
  projectPath: string;
  source: "claude" | "codex";
  sessionId: string;
}

/**
 * A tmux session to attach to, rather than a CLI to start.
 *
 * The distinction is the point: resuming a session opens a second client to a transcript, while
 * attaching shows the process somebody is already running. tmux is what makes the second viewer
 * legal, so watching a live agent goes through here and not through the resume above.
 */
export interface TmuxTerminalContext {
  kind: "tmux";
  /** As `GET /api/tmux/sessions` names it. */
  session: string;
}

/**
 * A provider session to watch in tmux, whether or not tmux is already running it.
 *
 * The two kinds above are the two answers to "is there a process yet", and a caller that only
 * knows a session id cannot pick between them: the panel would have to ask whether the session's
 * live process reports a tmux pane, and get null both for a session running outside tmux and for
 * one that is not running at all. This kind names the session and lets the sidecar decide -- attach
 * the pane the session is already in, otherwise start one that resumes it. Deciding it there is
 * also the only place it can be decided correctly, since between the panel's question and its open
 * the answer can change.
 */
export interface SessionTmuxTerminalContext {
  kind: "session-tmux";
  source: "claude" | "codex";
  sessionId: string;
}

/**
 * A NEW session forked from an existing transcript, run in its own tmux pane.
 *
 * Distinct from `session-tmux` because the two want opposite things. That one is "show me this
 * session", and it joins a live pane when there is one, precisely so two viewers never open two
 * clients onto one transcript. A fork is "give me a session that starts where this one is", so it
 * must never join anything: it always starts a process, and the process it starts writes a
 * different transcript.
 *
 * `forkId` names this fork rather than the thing it came from, so asking twice makes two forks and
 * re-opening one lands back on its own pane. The pane cannot be named after `sessionId` for the
 * same reason -- every fork of one session would collide on it.
 *
 * Claude only. `claude --resume <id> --fork-session` is a verified capability; Codex has `resume`
 * and no fork, so a Codex context is refused rather than silently resumed into the original.
 */
export interface SessionForkTerminalContext {
  kind: "session-fork";
  source: "claude";
  /** The transcript to fork FROM. Untouched: forking never writes to it. */
  sessionId: string;
  /**
   * This fork's own identity, minted by the caller.
   *
   * Also the session id the fork is STARTED with, so its transcript lands at this uuid rather than
   * one only the CLI knows. That is what lets a caller name a fork before it exists and find its
   * transcript afterwards without searching for it.
   */
  forkId: string;
  /**
   * What to call the fork, decided by the caller and passed to the CLI as `-n`.
   *
   * Required, and the sidecar derives nothing: naming a fork is the reader's act, taken in the
   * dialog that opens before the fork starts, so there is no second name for a default to be. A
   * caller with no opinion sends the proposal the panel offered rather than omitting the field,
   * which is what keeps one title on the wire instead of one here and another in the sidecar.
   */
  title: string;
  /**
   * The fork's first turn: what this fork is for, as opposed to what its parent was doing.
   *
   * Composed rather than delivered verbatim, which is the difference between this field and
   * `BotLaunchCommand.prompt`. A fork wakes up holding a context it did not build, mid-task, with
   * its parent still running and still holding those files -- so the sidecar prefixes a standing
   * handoff statement saying exactly that before the brief. Sending the statement from here
   * instead would put one copy on every caller, and the shortest copy would win.
   *
   * Absent means an ordinary fork: a pane branched from a session for a reader to type into. No
   * first turn is injected then, because there is no way to tell a session it is a fork without
   * also making it answer something.
   */
  brief?: string;
}

/**
 * A session that does not exist yet, started fresh in a directory.
 *
 * The sibling of the fork above, and the one kind that resolves nothing: every other kind names a
 * session or a pane that already exists, so the sidecar looks it up and refuses what it cannot
 * find. This one names a DIRECTORY and an id nobody has issued yet, so there is nothing to look up
 * -- which is exactly why it exists. A Bot with no sessions cannot reach any of the other kinds:
 * its picker is empty, and there is nothing to fork.
 *
 * `sessionId` is minted by the caller and passed to the CLI as `--session-id`, so the transcript
 * lands where the caller is already watching for it. Measured 2026-09-08: the flag stands alone,
 * without `--resume`, and the session writes no transcript at all until its first turn -- so the
 * id is the only way to recognise the session when it finally appears.
 *
 * The pane is the one this sidecar would have resumed the session into, which is deliberate: after
 * the first turn a `session-tmux` open of the same id finds this very pane instead of starting a
 * second client onto the transcript.
 *
 * Claude only, for the same reason forking is: `--session-id` and `-n` are Claude CLI flags, and
 * Codex offers neither, so a Codex session cannot be named or found before it speaks.
 */
export interface NewSessionTerminalContext {
  kind: "session-new";
  source: "claude";
  /** Where it runs. The Bot's own directory, and the one thing a fresh session cannot infer. */
  projectPath: string;
  /** This session's own identity, minted by the caller. See above. */
  sessionId: string;
  /**
   * What to call it, decided by the caller and passed to the CLI as `-n`.
   *
   * Required, and the sidecar derives nothing, for the reason the fork's is: `-n` sets the
   * session's ADDRESS as well as its title, so the name chosen here is the one every other agent
   * finds it by from its first moment.
   */
  title: string;
}

/** What a terminal is pointed at. */
export type AgentTerminalContext =
  | AgentSessionTerminalContext
  | TmuxTerminalContext
  | SessionTmuxTerminalContext
  | SessionForkTerminalContext
  | NewSessionTerminalContext;

/** `POST /api/terminals` request. */
export interface OpenAgentTerminalRequest {
  context: AgentTerminalContext;
  columns: number;
  rows: number;
}

/** `POST /api/terminals` response. */
export interface AgentTerminalDescriptor {
  terminalId: string;
  ptySessionName: string;
  pid: number;
  columns: number;
  rows: number;
  /**
   * The session this terminal BROUGHT INTO EXISTENCE, when it did that.
   *
   * Only a fork does: every other kind resumes or attaches a session that already had a name.
   *
   * The caller named it, so this is not how the name is learned. What it reports is that THIS open
   * is the one that started the session -- a second open of a live fork joins its pane and says
   * nothing, which is the difference between a session to attach to a Bot and one already attached.
   * The title travels with it as the name after trimming, so the two sides cannot drift.
   *
   * Absent means nothing was started.
   */
  startedSession?: { sessionId: string; title: string };
}

/** One terminal's message, carried inside an envelope on the shared stream. */
export type AgentTerminalStreamMessage =
  | {
      type: "checkpointBegin";
      checkpointId: string;
      revision: string;
      columns: number;
      rows: number;
      totalBytes: string;
      chunkCount: number;
      historyTruncated: boolean;
    }
  | { type: "checkpointChunk"; checkpointId: string; index: number; data: string }
  | { type: "checkpointEnd"; checkpointId: string; revision: string }
  | { type: "output"; revision: string; data: string }
  | {
      type: "viewport";
      ownershipEpoch: string;
      ownerClientId: string;
      ownerTitle: string;
      isOwner: boolean;
      sourceColumns: number;
      sourceRows: number;
      sourceRevision: string;
      viewColumns: number;
      viewRows: number;
    }
  | { type: "exited"; status: number }
  | { type: "detached" }
  | { type: "error"; message: string };

/**
 * One frame of `GET /api/terminals/stream`, the single stream carrying every open terminal.
 *
 * One stream rather than one per terminal because a browser on HTTP/1.1 holds about six
 * connections per origin and an EventSource holds one for as long as it lives, so a wall of
 * terminals would open its first six and leave the rest, and the panel's other requests, waiting
 * on a connection that never frees.
 */
export interface AgentTerminalStreamEnvelope {
  terminalId: string;
  message: AgentTerminalStreamMessage;
}

/**
 * `GET /api/terminals/{terminalId}/history` -- the scrollback the viewer was never sent.
 *
 * Base64, because it carries the escape sequences that colour it. Empty when the terminal has no
 * history behind it to hand over.
 */
export interface AgentTerminalHistory {
  data: string;
}

/** `POST /api/terminals/{terminalId}/input`. */
export interface AgentTerminalInput {
  data: string;
  encoding: "utf8" | "base64";
}

/** `POST /api/terminals/{terminalId}/viewport`. */
export interface AgentTerminalViewport {
  sequence: string;
  active: boolean;
  /**
   * Whether this viewer's box should become the pane's shape.
   *
   * A tmux window has ONE size for everyone, so a viewer that claims it reshapes the session in
   * whatever terminal its owner has it open in, and for the agent running there that is a reflow
   * of its whole screen. A surface big enough to be somewhere you work claims; a surface that is a
   * glance at a session living elsewhere does not, and scales its own type to fit instead.
   *
   * Measured 2026-09-08, which is why this is a field rather than an assumption: the composer's
   * terminal band on a canvas card claimed, and left two live sessions pinned at 48x9 and 56x16 --
   * small enough that Claude's TUI redrew its entire frame continuously, and still that size after
   * the band was closed.
   *
   * `columns` and `rows` are reported either way: the reply carries the pane's real shape and
   * whether it matches, which is what a follower scales against.
   */
  claim: boolean;
  columns: number;
  rows: number;
}

/** `POST /api/terminals/{terminalId}/close`. */
export interface CloseAgentTerminalRequest {
  mode: "detach" | "kill";
}
