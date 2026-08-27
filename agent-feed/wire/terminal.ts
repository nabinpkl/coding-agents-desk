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

/** One message of `GET /api/terminals/{terminalId}/stream`. */
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
