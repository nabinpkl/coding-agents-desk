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

/** What a terminal is pointed at. */
export type AgentTerminalContext =
  | AgentSessionTerminalContext
  | TmuxTerminalContext
  | SessionTmuxTerminalContext;

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
