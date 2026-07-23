/**
 * Thin, typed wrapper around the raw audio WebSocket to the FastAPI backend.
 * The browser connects DIRECTLY here (not through Next.js) to stream PCM and
 * receive partial/final transcripts and meters. Transport only: no capture,
 * no state, no feature logic. Messages are typed against the generated wire
 * contract so both ends stay in lockstep.
 */

import { VOICE_WS_URL } from "@/lib/config";
import { getHostConfig } from "@/lib/host-bridge";
import type {
  AudioFrameMessage,
  ClientWireMessage,
  ServerWireMessage,
  SessionStartMessage,
  SessionStopMessage,
} from "@/lib/wire";

export type ServerMessageHandler = (message: ServerWireMessage) => void;
export type SocketErrorHandler = (event: Event) => void;
export type SocketCloseHandler = (event: CloseEvent) => void;

export class VoiceSocketError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VoiceSocketError";
  }
}

export class VoiceSocket {
  private socket: WebSocket | null = null;
  private intentionalClose = false;
  private readonly messageHandlers = new Set<ServerMessageHandler>();
  private readonly errorHandlers = new Set<SocketErrorHandler>();
  private readonly closeHandlers = new Set<SocketCloseHandler>();

  private readonly url: string;

  /**
   * When embedded, the native host injects the loopback URL of its owned voice
   * sidecar via host config; in a plain browser we fall back to the build-time
   * constant. An explicit `url` argument always wins (tests, overrides).
   */
  constructor(url?: string) {
    this.url = url ?? getHostConfig()?.voiceWsUrl ?? VOICE_WS_URL;
  }

  /** Opens the connection. Resolves on open, rejects on the first error. */
  connect(): Promise<void> {
    if (this.socket) {
      if (this.socket.readyState === WebSocket.OPEN) {
        return Promise.resolve();
      }
      // CONNECTING or a stale socket: reject rather than silently opening a
      // second connection and orphaning the first.
      return Promise.reject(
        new VoiceSocketError("voice socket connect() called while not idle"),
      );
    }
    return new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.url);
      this.socket = socket;

      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener(
        "error",
        (event) => {
          reject(new VoiceSocketError(`voice socket failed: ${this.url}`));
          for (const handler of this.errorHandlers) handler(event);
        },
        { once: true },
      );
      // An unexpected close (backend error-close, dropped connection) must be
      // observable so the session can fail loud instead of hanging. A close we
      // initiated via close() is suppressed.
      socket.addEventListener(
        "close",
        (event) => {
          if (this.intentionalClose) return;
          for (const handler of this.closeHandlers) handler(event);
        },
        { once: true },
      );
      socket.addEventListener("message", (event) => {
        let message: ServerWireMessage;
        try {
          message = JSON.parse(event.data as string) as ServerWireMessage;
        } catch {
          return;
        }
        for (const handler of this.messageHandlers) handler(message);
      });
    });
  }

  /** Subscribe to server messages. Returns an unsubscribe function. */
  onMessage(handler: ServerMessageHandler): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  /** Subscribe to raw socket errors. Returns an unsubscribe function. */
  onError(handler: SocketErrorHandler): () => void {
    this.errorHandlers.add(handler);
    return () => this.errorHandlers.delete(handler);
  }

  /**
   * Subscribe to an unexpected close (not one initiated via `close()`).
   * Returns an unsubscribe function.
   */
  onClose(handler: SocketCloseHandler): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  /** Send a session control message (start/stop). */
  sendControl(message: SessionStartMessage | SessionStopMessage): void {
    this.send(message);
  }

  /** Send one PCM audio frame. */
  sendAudioFrame(frame: AudioFrameMessage): void {
    this.send(frame);
  }

  close(): void {
    this.intentionalClose = true;
    this.socket?.close();
    this.socket = null;
  }

  get readyState(): number {
    return this.socket?.readyState ?? WebSocket.CLOSED;
  }

  private send(message: ClientWireMessage): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new VoiceSocketError("voice socket is not open");
    }
    this.socket.send(JSON.stringify(message));
  }
}
