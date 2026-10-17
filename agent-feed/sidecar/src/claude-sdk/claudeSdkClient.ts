// The sidecar's side of the socket: one connection per SDK session someone is looking at.
//
// The sidecar holds nothing here that matters. Every pending question and approval lives in the
// runner, and a connection is handed all of it on arrival, so a sidecar that restarts is current
// again as soon as it reconnects -- which is what lets this process restart on every save while
// a question waits (ADR-0143).
//
// A runner that is not there yet is waited for by watching the socket directory, not polled: its
// socket appearing is the event. One watch for the directory, opened once and never closed, the
// shape `AGENTS.md` asks for under Bun.

import { watch } from "node:fs";
import { lstat } from "node:fs/promises";
import type { Socket } from "bun";
import {
  DISCONNECTED_CLAUDE_SDK_STATE,
  type ClaudeSdkSessionState,
} from "@agentdesk/agent-feed-wire";
import {
  encodeLine,
  LineReader,
  parseRunnerMessage,
  PROTOCOL_VERSION,
  runnerSocketPath,
  type RunnerReply,
  type SidecarToRunner,
} from "@/claude-sdk/claudeSdkProtocol";
import { privateSocketDirectory } from "@/claude-sdk/claudeSdkRunnerServer";

/** How long a command waits for the runner's reply before it is reported as not established. */
const REPLY_TIMEOUT_MS = 20_000;

export type RunnerCommand = DistributiveOmit<Exclude<SidecarToRunner, { type: "hello" }>, "id">;
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

/** A command that could not reach a runner at all, as distinct from one a runner refused. */
export const NO_RUNNER: RunnerReply = { ok: false, reason: "failed", message: "no runner is answering for this session" };

interface Connection {
  sessionId: string;
  state: ClaudeSdkSessionState;
  socket: Socket<undefined> | null;
  /** In flight, so two callers asking at once share one connect. */
  opening: Promise<boolean> | null;
  listeners: Set<(state: ClaudeSdkSessionState) => void>;
  replies: Map<string, { resolve: (reply: RunnerReply) => void; timer: ReturnType<typeof setTimeout> }>;
}

export class ClaudeSdkClient {
  private readonly connections = new Map<string, Connection>();
  private watching = false;
  /** The directory's privacy, checked once and awaited by every connect. */
  private directoryChecked: Promise<boolean> | null = null;
  private nextId = 0;

  constructor(
    private readonly socketDirectory: string,
    private readonly log: (line: string) => void = (line) => console.log(`[claude-sdk] ${line}`),
  ) {}

  /**
   * Follows one session's runner: its state now, and again on every change, including going away.
   *
   * The listener hears `connected: false` while there is no runner, and the real state from the
   * moment one answers -- one that starts after this call is found by its socket appearing.
   */
  observe(sessionId: string, listener: (state: ClaudeSdkSessionState) => void): () => void {
    const connection = this.connection(sessionId);
    connection.listeners.add(listener);
    listener(connection.state);
    void this.watchDirectory();
    void this.open(connection);
    return () => {
      connection.listeners.delete(listener);
      this.release(connection);
    };
  }

  /** Whether a runner is serving this session, connecting to find out. */
  async isServing(sessionId: string): Promise<boolean> {
    const connection = this.connection(sessionId);
    const serving = await this.open(connection);
    this.release(connection);
    return serving;
  }

  /** Sends one command and waits for the runner's answer to it. */
  async command(sessionId: string, command: RunnerCommand): Promise<RunnerReply> {
    const connection = this.connection(sessionId);
    if (!await this.open(connection) || !connection.socket) {
      this.release(connection);
      return NO_RUNNER;
    }
    const id = `c${++this.nextId}`;
    const reply = new Promise<RunnerReply>((resolve) => {
      const timer = setTimeout(() => {
        connection.replies.delete(id);
        resolve({ ok: false, reason: "failed", message: "the runner did not answer in time" });
      }, REPLY_TIMEOUT_MS);
      connection.replies.set(id, { resolve, timer });
    });
    connection.socket.write(encodeLine({ ...command, id } as SidecarToRunner));
    const answered = await reply;
    this.release(connection);
    return answered;
  }

  private connection(sessionId: string): Connection {
    let connection = this.connections.get(sessionId);
    if (!connection) {
      connection = {
        sessionId,
        state: DISCONNECTED_CLAUDE_SDK_STATE,
        socket: null,
        opening: null,
        listeners: new Set(),
        replies: new Map(),
      };
      this.connections.set(sessionId, connection);
    }
    return connection;
  }

  /** Connects if it is not already, answering whether a runner is there. */
  private open(connection: Connection): Promise<boolean> {
    if (connection.state.connected) return Promise.resolve(true);
    connection.opening ??= this.connect(connection).finally(() => (connection.opening = null));
    return connection.opening;
  }

  /**
   * Whether the socket directory is this user's alone, asked before the first connect and never
   * skipped. A runner's socket takes answers and approvals, so one in a directory another user
   * could write to -- `/tmp` names are predictable -- might be theirs, answering as a runner.
   */
  private directoryIsPrivate(): Promise<boolean> {
    this.directoryChecked ??= privateSocketDirectory(this.socketDirectory).then(
      () => true,
      (error: unknown) => {
        this.log(`refusing every runner: ${error instanceof Error ? error.message : String(error)}`);
        return false;
      },
    );
    return this.directoryChecked;
  }

  /** The socket file is a socket and this user's, so connecting to it reaches a runner of ours. */
  private async socketIsOurs(path: string): Promise<boolean> {
    const info = await lstat(path).catch(() => null);
    if (!info) return false;
    const ours = info.isSocket() && (typeof process.getuid !== "function" || info.uid === process.getuid());
    if (!ours) this.log(`refusing ${path}: not a socket of this user's`);
    return ours;
  }

  private async connect(connection: Connection): Promise<boolean> {
    const path = runnerSocketPath(this.socketDirectory, connection.sessionId);
    if (!await this.directoryIsPrivate() || !await this.socketIsOurs(path)) return false;
    const reader = new LineReader();
    let introduced = false;
    let greeted!: (ok: boolean) => void;
    const ready = new Promise<boolean>((resolve) => (greeted = resolve));
    const socket = await Bun.connect({
      unix: path,
      socket: {
        open: (socket) => void socket.write(encodeLine({ type: "hello", version: PROTOCOL_VERSION })),
        data: (_socket, chunk) => {
          let lines: string[];
          try {
            lines = reader.push(chunk);
          } catch (error) {
            this.log(`${connection.sessionId}: ${error instanceof Error ? error.message : String(error)}`);
            _socket.end();
            return;
          }
          for (const line of lines) {
            // Nothing counts until the runner has said which session it serves, in our protocol.
            if (!introduced) {
              introduced = this.introduces(connection, line);
              if (!introduced) {
                _socket.end();
                greeted(false);
                return;
              }
              continue;
            }
            this.receive(connection, line, greeted);
          }
        },
        close: (closing) => {
          greeted(false);
          this.closed(connection, closing);
        },
        error: () => {
          greeted(false);
        },
      },
    }).catch(() => null);
    if (!socket) return false;
    connection.socket = socket;
    const answered = await Promise.race([ready, Bun.sleep(5_000).then(() => false)]);
    if (!answered) socket.end();
    return answered;
  }

  /** Whether a connection's first line is a runner introducing itself for this session. */
  private introduces(connection: Connection, line: string): boolean {
    const message = parseRunnerMessage(line);
    if (message?.type === "hello" && message.version === PROTOCOL_VERSION && message.sessionId === connection.sessionId) {
      return true;
    }
    this.log(`${connection.sessionId}: refused a socket that did not introduce itself as this session's runner`);
    return false;
  }

  private receive(connection: Connection, line: string, greeted: (ok: boolean) => void): void {
    const message = parseRunnerMessage(line);
    if (!message) {
      this.log(`${connection.sessionId}: dropped a line that is not a runner message`);
      return;
    }
    switch (message.type) {
      case "hello":
        // Only the first line may introduce; a second is not a runner's.
        this.log(`${connection.sessionId}: dropped a second hello`);
        return;
      case "state":
        connection.state = { ...message.state, connected: true };
        greeted(true);
        this.publish(connection);
        return;
      case "reply": {
        const waiting = connection.replies.get(message.id);
        if (!waiting) return;
        connection.replies.delete(message.id);
        clearTimeout(waiting.timer);
        waiting.resolve(message.reply);
        return;
      }
      default: {
        const unhandled: never = message;
        this.log(`${connection.sessionId}: unhandled runner message ${JSON.stringify(unhandled)}`);
      }
    }
  }

  private closed(connection: Connection, socket: Socket<undefined>): void {
    if (connection.socket && connection.socket !== socket) return;
    connection.socket = null;
    for (const waiting of connection.replies.values()) {
      clearTimeout(waiting.timer);
      waiting.resolve(NO_RUNNER);
    }
    connection.replies.clear();
    const was = connection.state.connected;
    connection.state = DISCONNECTED_CLAUDE_SDK_STATE;
    if (was) this.publish(connection);
    this.release(connection);
  }

  /** Drops a connection nobody is following and nothing is waiting on. */
  private release(connection: Connection): void {
    if (connection.listeners.size > 0 || connection.replies.size > 0 || connection.opening) return;
    connection.socket?.end();
    connection.socket = null;
    this.connections.delete(connection.sessionId);
  }

  private publish(connection: Connection): void {
    for (const listener of connection.listeners) listener(connection.state);
  }

  /** One watch on the socket directory, so a runner that starts later is noticed when it does. */
  private async watchDirectory(): Promise<void> {
    if (this.watching) return;
    this.watching = true;
    if (!await this.directoryIsPrivate()) return;
    try {
      watch(this.socketDirectory, (_event, file) => {
        const sessionId = typeof file === "string" && file.endsWith(".sock") ? file.slice(0, -".sock".length) : null;
        const connection = sessionId ? this.connections.get(sessionId) : undefined;
        if (connection && connection.listeners.size > 0 && !connection.state.connected) void this.open(connection);
      });
    } catch (error) {
      this.watching = false;
      this.log(`cannot watch ${this.socketDirectory}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
