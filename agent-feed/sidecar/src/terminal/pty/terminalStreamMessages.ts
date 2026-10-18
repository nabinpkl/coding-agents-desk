// One PTY manager envelope, read as the one thing the wire says about a terminal.
//
// A translation and nothing else: every field the daemon leaves unset gets the default a
// viewer can paint, so the service never has to reason about a half-filled protobuf. Null
// means the envelope carried nothing a viewer would show, which is not an error.

import type { AgentTerminalStreamMessage } from "@agentdesk/agent-feed-wire";
import type { PtyEnvelope } from "@/terminal/pty/ptyProtocol";

const BOOTSTRAP_COLUMNS = 80;
const BOOTSTRAP_ROWS = 24;

export function streamMessage(envelope: PtyEnvelope): AgentTerminalStreamMessage | null {
  if (envelope.output) {
    return {
      type: "output",
      revision: envelope.output.revision ?? "0",
      data: envelope.output.data ?? "",
    };
  }
  if (envelope.terminalCheckpointBegin) {
    const value = envelope.terminalCheckpointBegin;
    return {
      type: "checkpointBegin",
      checkpointId: value.checkpointId ?? "0",
      revision: value.revision ?? "0",
      columns: value.columns ?? BOOTSTRAP_COLUMNS,
      rows: value.rows ?? BOOTSTRAP_ROWS,
      totalBytes: value.totalBytes ?? "0",
      chunkCount: value.chunkCount ?? 0,
      historyTruncated: value.historyTruncated ?? false,
    };
  }
  if (envelope.terminalCheckpointChunk) {
    const value = envelope.terminalCheckpointChunk;
    return {
      type: "checkpointChunk",
      checkpointId: value.checkpointId ?? "0",
      index: value.index ?? 0,
      data: value.data ?? "",
    };
  }
  if (envelope.terminalCheckpointEnd) {
    return {
      type: "checkpointEnd",
      checkpointId: envelope.terminalCheckpointEnd.checkpointId ?? "0",
      revision: envelope.terminalCheckpointEnd.revision ?? "0",
    };
  }
  if (envelope.terminalViewportStatus) {
    const value = envelope.terminalViewportStatus;
    return {
      type: "viewport",
      ownershipEpoch: value.ownershipEpoch ?? "0",
      ownerClientId: value.ownerClientId ?? "0",
      ownerTitle: value.ownerTitle ?? "",
      isOwner: value.isOwner ?? false,
      sourceColumns: value.sourceColumns ?? BOOTSTRAP_COLUMNS,
      sourceRows: value.sourceRows ?? BOOTSTRAP_ROWS,
      sourceRevision: value.sourceRevision ?? "0",
      viewColumns: value.viewColumns ?? BOOTSTRAP_COLUMNS,
      viewRows: value.viewRows ?? BOOTSTRAP_ROWS,
    };
  }
  if (envelope.sessionExited) return { type: "exited", status: envelope.sessionExited.status ?? 0 };
  if (envelope.clientDetached) return { type: "detached" };
  if (envelope.error) return { type: "error", message: envelope.error.message ?? "PTY manager error" };
  return null;
}
