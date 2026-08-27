import {
  PTY_PROTOCOL_VERSION,
  framePtyEnvelope,
  takePtyFrames,
  type PtyEnvelope,
  type PtySessionSummary,
} from "./ptyProtocol.ts";

type EnvelopeListener = (envelope: PtyEnvelope) => void;
type FailureListener = (error: Error) => void;
const PTY_RESPONSE_TIMEOUT_MS = 5_000;

class PtySocket {
  private socket: Bun.Socket<undefined> | null = null;
  private buffered: Uint8Array<ArrayBufferLike> = new Uint8Array();
  private readonly listeners = new Set<EnvelopeListener>();
  private readonly failureListeners = new Set<FailureListener>();
  private failure: Error | null = null;

  static async connect(socketPath: string): Promise<PtySocket> {
    const transport = new PtySocket();
    transport.socket = await Bun.connect({
      unix: socketPath,
      socket: {
        binaryType: "uint8array",
        data: (_socket, bytes) => transport.receive(bytes),
        close: () => transport.fail(new Error("PTY manager connection closed")),
        error: (_socket, error) => transport.fail(error),
        connectError: (_socket, error) => transport.fail(error),
      },
    });
    return transport;
  }

  send(envelope: PtyEnvelope): void {
    if (this.failure) throw this.failure;
    if (!this.socket) throw new Error("PTY manager connection is not open");
    const frame = framePtyEnvelope(envelope);
    const written = this.socket.write(frame);
    if (written !== frame.byteLength) {
      throw new Error(`PTY manager accepted ${written} of ${frame.byteLength} bytes`);
    }
  }

  onEnvelope(listener: EnvelopeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onFailure(listener: FailureListener): () => void {
    if (this.failure) listener(this.failure);
    else this.failureListeners.add(listener);
    return () => this.failureListeners.delete(listener);
  }

  waitFor(
    predicate: (envelope: PtyEnvelope) => boolean,
    timeoutMs = PTY_RESPONSE_TIMEOUT_MS,
  ): Promise<PtyEnvelope> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const deadline = setTimeout(() => {
        removeEnvelope();
        removeFailure();
        reject(new Error(`PTY manager did not respond within ${timeoutMs} ms`));
      }, timeoutMs);
      const removeEnvelope = this.onEnvelope((envelope) => {
        if (!predicate(envelope)) return;
        clearTimeout(deadline);
        removeEnvelope();
        removeFailure();
        resolve(envelope);
      });
      const removeFailure = this.onFailure((error) => {
        clearTimeout(deadline);
        removeEnvelope();
        removeFailure();
        reject(error);
      });
    });
  }

  close(): void {
    this.socket?.end();
    this.socket = null;
    this.fail(new Error("PTY manager connection closed"));
  }

  private receive(bytes: Uint8Array): void {
    const combined = new Uint8Array(this.buffered.byteLength + bytes.byteLength);
    combined.set(this.buffered);
    combined.set(bytes, this.buffered.byteLength);
    let decoded: ReturnType<typeof takePtyFrames>;
    try {
      decoded = takePtyFrames(combined);
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
      this.socket?.end();
      return;
    }
    this.buffered = decoded.remainder;
    for (const envelope of decoded.frames) {
      if (envelope.protocolVersion !== PTY_PROTOCOL_VERSION) {
        this.fail(new Error(`unsupported PTY protocol ${envelope.protocolVersion}`));
        this.socket?.end();
        return;
      }
      for (const listener of this.listeners) listener(envelope);
    }
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    for (const listener of this.failureListeners) listener(error);
    this.failureListeners.clear();
    this.listeners.clear();
  }
}

export interface PtyCommandLaunch {
  cwd: string;
  executable: string;
  arguments: string[];
}

export interface PtySessionAttachment {
  sessionName: string;
  pid: number;
  columns: number;
  rows: number;
}

export class PtySessionConnection {
  private nextRequestId = 1;

  constructor(
    readonly attachment: PtySessionAttachment,
    private readonly transport: PtySocket,
  ) {}

  onEnvelope(listener: EnvelopeListener): () => void {
    return this.transport.onEnvelope((envelope) => {
      if (!envelope.sessionName || envelope.sessionName === this.attachment.sessionName) {
        listener(envelope);
      }
    });
  }

  onFailure(listener: FailureListener): () => void {
    return this.transport.onFailure(listener);
  }

  sendInput(data: string): void {
    this.send({ input: { data: Buffer.from(data).toString("base64") } });
  }

  sendBinaryInput(data: string): void {
    this.send({ input: { data } });
  }

  updateViewerState(options: {
    sequence: string;
    active: boolean;
    claim: boolean;
    columns: number;
    rows: number;
  }): void {
    this.send({ terminalViewerState: options });
  }

  requestCheckpoint(lastAppliedRevision: string): void {
    this.send({ requestTerminalCheckpoint: { lastAppliedRevision } });
  }

  detach(): void {
    this.send({ detach: {} });
    this.transport.close();
  }

  kill(): void {
    this.send({ killSession: {} });
  }

  closeTransport(): void {
    this.transport.close();
  }

  private send(payload: Omit<PtyEnvelope, "protocolVersion" | "requestId" | "sessionName">): void {
    this.nextRequestId += 1;
    this.transport.send({
      protocolVersion: PTY_PROTOCOL_VERSION,
      requestId: String(this.nextRequestId),
      sessionName: this.attachment.sessionName,
      ...payload,
    });
  }
}

export class PtyManagerClient {
  constructor(private readonly socketPath: string) {}

  async listSessions(): Promise<PtySessionSummary[]> {
    const transport = await PtySocket.connect(this.socketPath);
    try {
      const response = transport.waitFor((envelope) => Boolean(envelope.sessionList || envelope.error));
      transport.send({
        protocolVersion: PTY_PROTOCOL_VERSION,
        requestId: "1",
        listSessions: {},
      });
      const envelope = await response;
      if (envelope.error) throw new Error(envelope.error.message || "PTY manager refused session list");
      return envelope.sessionList?.sessions ?? [];
    } finally {
      transport.close();
    }
  }

  async openSession(options: {
    sessionName: string;
    launch: PtyCommandLaunch;
    columns: number;
    rows: number;
    createIfMissing: boolean;
    clientTitle: string;
  }): Promise<PtySessionConnection> {
    const transport = await PtySocket.connect(this.socketPath);
    try {
      const response = transport.waitFor((envelope) => Boolean(envelope.attached || envelope.error));
      transport.send({
        protocolVersion: PTY_PROTOCOL_VERSION,
        requestId: "1",
        sessionName: options.sessionName,
        createOrAttach: {
          commandLaunch: options.launch,
          columns: options.columns,
          rows: options.rows,
          createIfMissing: options.createIfMissing,
          clientTitle: options.clientTitle,
        },
      });
      const envelope = await response;
      if (envelope.error) throw new Error(envelope.error.message || "PTY manager refused attach");
      const attached = envelope.attached;
      if (!attached?.pid || attached.pid <= 0) throw new Error("PTY manager returned an invalid attachment");
      return new PtySessionConnection({
        sessionName: envelope.sessionName || options.sessionName,
        pid: attached.pid,
        columns: attached.columns || options.columns,
        rows: attached.rows || options.rows,
      }, transport);
    } catch (error) {
      transport.close();
      throw error;
    }
  }
}
