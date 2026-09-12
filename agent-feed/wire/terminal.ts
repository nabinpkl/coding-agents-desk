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
}

/** What a terminal is pointed at. */
export type AgentTerminalContext =
  | AgentSessionTerminalContext
  | TmuxTerminalContext
  | SessionTmuxTerminalContext
  | SessionForkTerminalContext;

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
   * Only a fork does: every other kind resumes or attaches a session that already had a name. The
   * sidecar is the one that picks a fork's name, so it says which it picked rather than leaving
   * the caller to re-derive it -- two implementations of one counting rule, run against catalogs
   * that can differ by a moment, would disagree exactly when two forks are made at once.
   *
   * Absent means nothing was started, not that the name is unknown.
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
  claim: boolean;
  columns: number;
  rows: number;
}

/** `POST /api/terminals/{terminalId}/close`. */
export interface CloseAgentTerminalRequest {
  mode: "detach" | "kill";
}
