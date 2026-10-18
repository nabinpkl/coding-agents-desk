// The sidecar's side of the socket: one connection per SDK session someone is looking at.
//
// The sidecar holds nothing here that matters. Every callback the CLI waits on lives in the runner,
// and a connection is handed the latest of everything the runner keeps on arrival, which
// `SdkSession` folds back into the session's state -- so a sidecar that restarts is current again
// as soon as it reconnects, which is what lets this process restart on every save while a question
// waits (ADR-0143, ADR-0144).
//
// A runner whose build is not what is on disk now is stale: told to `onStale` on every change of
// its state, which relaunches it once the session is idle.
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
  runnerBuild,
  runnerSocketPath,
  type RunnerChoices,
  type RunnerReply,
  type SidecarToRunner,
} from "@/claude-sdk/claudeSdkProtocol";
import { sdkModels, SdkSession, type SessionCommand, type SessionReply } from "@/claude-sdk/claudeSdkSession";
import { config } from "@/config/config";
import { privateSocketDirectory } from "@/claude-sdk/claudeSdkRunnerServer";
import type { ClaudeSdkLiveFeed } from "@/claude-sdk/claudeSdkLiveFeed";

/** How long a command waits for the runner's reply before it is reported as not established. */
const REPLY_TIMEOUT_MS = 20_000;

type RunnerMessage = DistributiveOmit<Exclude<SidecarToRunner, { type: "hello" }>, "id">;
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

/** A command that could not reach a runner at all, as distinct from one a runner refused. */
export const NO_RUNNER: SessionReply = { ok: false, reason: "failed", message: "no runner is answering for this session" };
const NO_RUNNER_REPLY: RunnerReply = { ok: false, message: NO_RUNNER.message };

interface Connection {
  sessionId: string;
  state: ClaudeSdkSessionState;
  /** The session as its runner's records say, from its hello; null while none is connected. */
  session: SdkSession | null;
  /** Whether the runner runs code older than what is on disk now. */
  stale: boolean;
  socket: Socket<undefined> | null;
  /** In flight, so two callers asking at once share one connect. */
  opening: Promise<boolean> | null;
  listeners: Set<(state: ClaudeSdkSessionState) => void>;
  replies: Map<string, { resolve: (reply: RunnerReply) => void; timer: ReturnType<typeof setTimeout> }>;
}

let shared: ClaudeSdkClient | null = null;

/**
 * The process's one client, which everything that talks to runners shares: the routes, and the
 * session operations (rename) that reach a session through its runner. One connection per session
 * however many of them ask. The first caller supplies the live mirror's sink; `server.ts` mounts the
 * routes, which do, before anything else can ask.
 */
export function sharedClaudeSdkClient(sink: Pick<ClaudeSdkLiveFeed, "stream" | "gone"> | null = null): ClaudeSdkClient {
  shared ??= new ClaudeSdkClient(config.claudeSdkSocketDirectory, undefined, sink, (client, sessionId, state) =>
    // Imported when first needed: the relaunch reaches tmux and the catalog, which this module does not.
    void import("@/claude-sdk/claudeSdkSwitch").then(({ relaunchStaleRunner }) => relaunchStaleRunner(client, sessionId, state)));
  return shared;
}

/** Called on every state of a runner whose code is older than what is on disk. */
export type StaleRunner = (client: ClaudeSdkClient, sessionId: string, state: ClaudeSdkSessionState) => void;

export class ClaudeSdkClient {
  private readonly connections = new Map<string, Connection>();
  private watching = false;
  /** The directory's privacy, checked once and awaited by every connect. */
  private directoryChecked: Promise<boolean> | null = null;
  private nextId = 0;

  constructor(
    private readonly socketDirectory: string,
    private readonly log: (line: string) => void = (line) => console.log(`[claude-sdk] ${line}`),
    /** Where the runners' streamed messages go: the live mirror, through `ClaudeSdkLiveFeed`. */
    private readonly sink: Pick<ClaudeSdkLiveFeed, "stream" | "gone"> | null = null,
    private readonly onStale: StaleRunner | null = null,
    /** What a runner started now would report; read from disk on each introduction by default. */
    private readonly currentBuild: () => string = runnerBuild,
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

  /** The runner's state now, connecting to ask; the disconnected state when none answers. */
  async state(sessionId: string): Promise<ClaudeSdkSessionState> {
    const connection = this.connection(sessionId);
    await this.open(connection);
    const state = connection.state;
    this.release(connection);
    return state;
  }

  /**
   * The model and effort the session has chosen, to launch its next runner with; empty when none
   * were chosen, or when no runner of this protocol answers to say.
   */
  async choices(sessionId: string): Promise<RunnerChoices> {
    const connection = this.connection(sessionId);
    await this.open(connection);
    const choices = connection.session?.choices() ?? {};
    this.release(connection);
    return choices;
  }

  /** Whether a runner is serving this session, connecting to find out. */
  async isServing(sessionId: string): Promise<boolean> {
    return (await this.state(sessionId)).connected;
  }

  /** Carries out one of the panel's commands, answering whether it happened and why not. */
  async command(sessionId: string, command: SessionCommand): Promise<SessionReply> {
    const connection = this.connection(sessionId);
    if (!await this.open(connection) || !connection.session) {
      this.release(connection);
      return NO_RUNNER;
    }
    const plan = connection.session.plan(command);
    if ("refuse" in plan) {
      this.release(connection);
      return plan.refuse;
    }
    const reply = await this.send(connection, plan.send);
    this.release(connection);
    if (reply === NO_RUNNER_REPLY) return NO_RUNNER;
    if (reply.ok) return { ok: true };
    // A callback the runner no longer holds was settled elsewhere, or the turn moved on.
    return { ok: false, reason: plan.send.type === "settle" ? "not-pending" : "failed", message: reply.message };
  }

  /** Sends one message to a connected runner and waits for its reply. */
  private send(connection: Connection, message: RunnerMessage): Promise<RunnerReply> {
    if (!connection.socket) return Promise.resolve(NO_RUNNER_REPLY);
    const id = `c${++this.nextId}`;
    const reply = new Promise<RunnerReply>((resolve) => {
      const timer = setTimeout(() => {
        connection.replies.delete(id);
        resolve({ ok: false, message: "the runner did not answer in time" });
      }, REPLY_TIMEOUT_MS);
      connection.replies.set(id, { resolve, timer });
    });
    connection.socket.write(encodeLine({ ...message, id } as SidecarToRunner));
    return reply;
  }

  private connection(sessionId: string): Connection {
    let connection = this.connections.get(sessionId);
    if (!connection) {
      connection = {
        sessionId,
        state: DISCONNECTED_CLAUDE_SDK_STATE,
        session: null,
        stale: false,
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

  /**
   * Whether a connection's first line is a runner introducing itself for this session. A runner
   * from before this protocol is refused like any stranger, and reads as not connected: it can still
   * be switched to the terminal and back, which starts it on the code it should be running.
   */
  private introduces(connection: Connection, line: string): boolean {
    const message = parseRunnerMessage(line);
    if (message?.type === "hello" && message.version === PROTOCOL_VERSION && message.sessionId === connection.sessionId) {
      connection.session = new SdkSession(connection.sessionId, message.allowBypass, message.choices);
      connection.stale = message.build !== this.currentBuild();
      if (connection.stale) this.log(`${connection.sessionId}: its runner is build ${message.build}, older than this code`);
      return true;
    }
    if (this.olderRunner(connection, line)) return false;
    this.log(`${connection.sessionId}: refused a socket that did not introduce itself as this session's runner`);
    return false;
  }

  /**
   * Whether the line is this session's runner introducing itself in another protocol: one started
   * before the protocol changed. It cannot be read, but it can be relaunched on this code once the
   * session is idle, judged by the registry; until then the session reads as not connected.
   */
  private olderRunner(connection: Connection, line: string): boolean {
    let hello: Record<string, unknown>;
    try {
      hello = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return false;
    }
    if (hello?.type !== "hello" || hello.sessionId !== connection.sessionId || hello.version === PROTOCOL_VERSION) return false;
    this.log(`${connection.sessionId}: its runner speaks protocol ${String(hello.version)}, not ${PROTOCOL_VERSION}; relaunching it once idle`);
    this.onStale?.(this, connection.sessionId, DISCONNECTED_CLAUDE_SDK_STATE);
    return true;
  }

  private receive(connection: Connection, line: string, greeted: (ok: boolean) => void): void {
    const message = parseRunnerMessage(line);
    const session = connection.session;
    if (!message || !session) {
      this.log(`${connection.sessionId}: dropped a line that is not a runner message`);
      return;
    }
    switch (message.type) {
      case "hello":
        // Only the first line may introduce; a second is not a runner's.
        this.log(`${connection.sessionId}: dropped a second hello`);
        return;
      case "record": {
        const frame = session.fold(message.record);
        // The mirror takes what is happening now; a replayed event is already in the transcript.
        if (frame && !message.replay) this.sink?.stream(connection.sessionId, frame);
        this.update(connection);
        return;
      }
      case "callback": {
        const refusal = session.hold(message.callback);
        if (refusal) {
          void this.send(connection, { type: "settle", callback: message.callback.id, result: refusal as { behavior: "deny" } });
        }
        this.update(connection);
        return;
      }
      case "settled":
        session.settled(message.callback);
        this.update(connection);
        return;
      case "replayed":
        connection.state = { ...session.state(), connected: true };
        greeted(true);
        this.publish(connection);
        void this.loadModels(connection, session);
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

  /**
   * The state again once the replay is done, when it changed; before the replay ends it is still
   * being folded in. Most records change nothing -- a streamed token is one -- and a reader is sent
   * a state only when there is a new one, as the runner did when it kept the state itself.
   */
  private update(connection: Connection): void {
    if (!connection.state.connected || !connection.session) return;
    const next: ClaudeSdkSessionState = { ...connection.session.state(), connected: true };
    if (JSON.stringify(next) === JSON.stringify(connection.state)) return;
    connection.state = next;
    this.publish(connection);
  }

  /**
   * The models this `claude` offers, asked once per connection. A failure leaves the list empty,
   * which the panel reads as nothing to switch to rather than as an error to show.
   */
  private async loadModels(connection: Connection, session: SdkSession): Promise<void> {
    const reply = await this.send(connection, { type: "call", method: "supportedModels", args: [] });
    if (!reply.ok) {
      this.log(`${connection.sessionId}: could not list the models: ${reply.message}`);
      return;
    }
    if (connection.session !== session) return;
    session.setModels(sdkModels(reply.value));
    this.update(connection);
  }

  private closed(connection: Connection, socket: Socket<undefined>): void {
    if (connection.socket && connection.socket !== socket) return;
    connection.socket = null;
    for (const waiting of connection.replies.values()) {
      clearTimeout(waiting.timer);
      waiting.resolve(NO_RUNNER_REPLY);
    }
    connection.replies.clear();
    const was = connection.state.connected;
    connection.state = DISCONNECTED_CLAUDE_SDK_STATE;
    connection.session = null;
    connection.stale = false;
    if (was) {
      this.sink?.gone(connection.sessionId);
      this.publish(connection);
    }
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
    if (connection.stale) this.onStale?.(this, connection.sessionId, connection.state);
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
