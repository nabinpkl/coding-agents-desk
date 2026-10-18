import { parse } from "protobufjs";
import ptyProtocolSource from "@repo/terminal/pty-manager/proto/pty.proto" with { type: "text" };

export const PTY_PROTOCOL_VERSION = 7;
export const MAXIMUM_PTY_FRAME_BYTES = 16 * 1024 * 1024;

export interface PtyEnvelope {
  protocolVersion: number;
  requestId?: string;
  sessionName?: string;
  hello?: { clientName?: string };
  createOrAttach?: {
    commandLaunch?: { cwd?: string; executable?: string; arguments?: string[] };
    columns?: number;
    rows?: number;
    createIfMissing?: boolean;
    clientTitle?: string;
  };
  attached?: {
    pid?: number;
    cwd?: string;
    shell?: string;
    clientCount?: number;
    clientId?: string;
    columns?: number;
    rows?: number;
    revision?: string;
    ownerClientId?: string;
    ownershipEpoch?: string;
  };
  input?: { data?: string };
  output?: { data?: string; revision?: string };
  listSessions?: Record<string, never>;
  sessionList?: { sessions?: PtySessionSummary[] };
  killSession?: Record<string, never>;
  sessionExited?: { status?: number };
  error?: { message?: string };
  detach?: Record<string, never>;
  clientDetached?: { clientId?: string };
  requestTerminalCheckpoint?: { lastAppliedRevision?: string };
  terminalViewerState?: {
    sequence?: string;
    active?: boolean;
    claim?: boolean;
    columns?: number;
    rows?: number;
  };
  terminalViewportStatus?: {
    ownershipEpoch?: string;
    ownerClientId?: string;
    ownerTitle?: string;
    isOwner?: boolean;
    sourceColumns?: number;
    sourceRows?: number;
    sourceRevision?: string;
    viewColumns?: number;
    viewRows?: number;
  };
  terminalCheckpointBegin?: {
    checkpointId?: string;
    revision?: string;
    columns?: number;
    rows?: number;
    totalBytes?: string;
    chunkCount?: number;
    historyTruncated?: boolean;
  };
  terminalCheckpointChunk?: { checkpointId?: string; index?: number; data?: string };
  terminalCheckpointEnd?: { checkpointId?: string; revision?: string };
}

export interface PtySessionSummary {
  name?: string;
  cwd?: string;
  shell?: string;
  pid?: number;
  state?: "SESSION_STATE_UNSPECIFIED" | "SESSION_STATE_RUNNING" | "SESSION_STATE_EXITED" | number;
  columns?: number;
  rows?: number;
  revision?: string;
}

const envelopeType = parse(ptyProtocolSource, { keepCase: false }).root.lookupType(
  "pty.v1.Envelope",
);

export function encodePtyEnvelope(envelope: PtyEnvelope): Uint8Array {
  const message = envelopeType.fromObject(envelope);
  const error = envelopeType.verify(message);
  if (error) throw new Error(`invalid PTY envelope: ${error}`);
  return envelopeType.encode(message).finish();
}

export function decodePtyEnvelope(bytes: Uint8Array): PtyEnvelope {
  return envelopeType.toObject(envelopeType.decode(bytes), {
    bytes: String,
    longs: String,
    enums: String,
    defaults: false,
    oneofs: true,
  }) as unknown as PtyEnvelope;
}

export function framePtyEnvelope(envelope: PtyEnvelope): Uint8Array {
  const payload = encodePtyEnvelope(envelope);
  if (payload.byteLength > MAXIMUM_PTY_FRAME_BYTES) {
    throw new Error(`PTY frame is too large: ${payload.byteLength}`);
  }
  const framed = new Uint8Array(4 + payload.byteLength);
  new DataView(framed.buffer).setUint32(0, payload.byteLength, false);
  framed.set(payload, 4);
  return framed;
}

export function takePtyFrames(bytes: Uint8Array): {
  frames: PtyEnvelope[];
  remainder: Uint8Array;
} {
  const frames: PtyEnvelope[] = [];
  let offset = 0;
  while (bytes.byteLength - offset >= 4) {
    const length = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, false);
    if (length > MAXIMUM_PTY_FRAME_BYTES) throw new Error(`invalid PTY frame length: ${length}`);
    if (bytes.byteLength - offset - 4 < length) break;
    frames.push(decodePtyEnvelope(bytes.subarray(offset + 4, offset + 4 + length)));
    offset += 4 + length;
  }
  return { frames, remainder: bytes.slice(offset) };
}
