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
export interface AgentTerminalContext {
  projectPath: string;
  source: "claude" | "codex";
  sessionId: string;
}

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
