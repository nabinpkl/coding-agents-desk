// The runner's side of the socket: what the session says out, the sidecar's inputs and calls in.
//
// Any number of connections, because more than one sidecar can be looking -- the one that started
// the runner, the one it restarted into, a second panel's. Each is sent `hello`, then on its own
// `hello` everything the runner keeps (the latest records and the open callbacks), then every event
// as it happens, so a sidecar that missed everything while it restarted is current from its first
// read.

import { lstat, mkdir, unlink } from "node:fs/promises";
import type { Socket, TCPSocketListener } from "bun";
import type { ClaudeSdkRunner } from "@/claude-sdk/claudeSdkRunner";
import type { PermissionResult, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  encodeLine,
  LineReader,
  LineWriter,
  parseSidecarMessage,
  PROTOCOL_VERSION,
  type RunnerReply,
  type RunnerToSidecar,
  type SidecarToRunner,
} from "@/claude-sdk/claudeSdkProtocol";

/**
 * Unsent bytes one connection may hold before it is closed. What a runner sends is what `claude`
 * says, never the images a prompt carries the other way, so this stays well under the line cap.
 */
const MAXIMUM_BACKLOG_BYTES = 16 * 1024 * 1024;

interface Connection {
  reader: LineReader;
  /** Keeps what the kernel has not taken yet; flushed on `drain`. */
  writer: LineWriter;
  greeted: boolean;
}

/**
 * The directory the sockets live in, made private if it is new and refused if it is not.
 *
 * A socket here takes commands that answer questions and approve tool calls, so a directory another
 * user could write into would let them put a socket of their own where the sidecar looks.
 */
export async function privateSocketDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory()) throw new Error(`${directory} is not a directory`);
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new Error(`${directory} belongs to another user`);
  }
  if ((info.mode & 0o077) !== 0) throw new Error(`${directory} is readable by other users`);
}

/**
 * Clears a socket file a dead runner left, and refuses one a live runner is answering on.
 *
 * Two runners for one session would be two writers on one transcript (ADR-0143), so the second
 * stops here rather than taking the path over.
 */
async function claimSocketPath(path: string): Promise<void> {
  const info = await lstat(path).catch(() => null);
  if (!info) return;
  if (!info.isSocket()) throw new Error(`${path} exists and is not a socket`);
  const live = await Bun.connect({ unix: path, socket: { data() {} } }).then(
    (socket) => (socket.end(), true),
    () => false,
  );
  if (live) throw new Error(`a runner is already serving this session at ${path}`);
  await unlink(path);
}

export interface RunnerServer {
  close(): Promise<void>;
}

export async function serveRunner(
  runner: ClaudeSdkRunner,
  identity: { sessionId: string; socketPath: string; build: string },
  log: (line: string) => void,
): Promise<RunnerServer> {
  await claimSocketPath(identity.socketPath);
  const connections = new Set<Socket<Connection>>();

  const send = (socket: Socket<Connection>, message: RunnerToSidecar): void => {
    // A sidecar that stopped reading is let go rather than buffered for without bound. It loses
    // nothing it cannot have back: a connection is handed everything kept again on arrival.
    if (!socket.data.writer.write(socket, encodeLine(message))) {
      log("closed a connection that stopped reading");
      socket.end();
    }
  };

  const unsubscribe = runner.subscribe((event) => {
    const message: RunnerToSidecar = event.type === "record" ? { ...event, replay: false } : event;
    for (const socket of connections) if (socket.data.greeted) send(socket, message);
  });

  const execute = async (message: Exclude<SidecarToRunner, { type: "hello" }>): Promise<RunnerReply> => {
    switch (message.type) {
      case "input":
        return runner.input(message.message as unknown as SDKUserMessage);
      case "call":
        return runner.call(message.method, message.args);
      case "settle":
        return runner.resolve(message.callback, message.result as unknown as PermissionResult);
      case "stop":
        await runner.stop();
        return { ok: true, value: null };
      default: {
        const unhandled: never = message;
        throw new Error(`unhandled runner command ${JSON.stringify(unhandled)}`);
      }
    }
  };

  const receive = (socket: Socket<Connection>, line: string): void => {
    const message = parseSidecarMessage(line);
    if (!message) {
      log(`dropped a message that is not a command: ${line.slice(0, 120)}`);
      return;
    }
    if (message.type === "hello") {
      if (message.version !== PROTOCOL_VERSION) {
        log(`refused a sidecar speaking protocol ${message.version}; this runner speaks ${PROTOCOL_VERSION}`);
        socket.end();
        return;
      }
      socket.data.greeted = true;
      const { records, callbacks } = runner.snapshot();
      for (const record of records) send(socket, { type: "record", record, replay: true });
      for (const callback of callbacks) send(socket, { type: "callback", callback });
      send(socket, { type: "replayed" });
      return;
    }
    if (!socket.data.greeted) {
      log("dropped a command sent before hello");
      return;
    }
    void execute(message).then(
      (reply) => send(socket, { type: "reply", id: message.id, reply }),
      (error: unknown) =>
        send(socket, {
          type: "reply",
          id: message.id,
          reply: { ok: false, message: error instanceof Error ? error.message : String(error) },
        }),
    );
  };

  const listener: TCPSocketListener<Connection> = Bun.listen<Connection>({
    unix: identity.socketPath,
    socket: {
      open(socket) {
        socket.data = { reader: new LineReader(), writer: new LineWriter(MAXIMUM_BACKLOG_BYTES), greeted: false };
        connections.add(socket);
        send(socket, {
          type: "hello",
          version: PROTOCOL_VERSION,
          sessionId: identity.sessionId,
          pid: process.pid,
          build: identity.build,
          allowBypass: runner.allowBypass,
          choices: runner.choices,
          permissionMode: runner.permissionMode,
        });
      },
      data(socket, chunk) {
        let lines: string[];
        try {
          lines = socket.data.reader.push(chunk);
        } catch (error) {
          log(`closed a connection: ${error instanceof Error ? error.message : String(error)}`);
          socket.end();
          return;
        }
        for (const line of lines) receive(socket, line);
      },
      drain(socket) {
        socket.data.writer.flush(socket);
      },
      close(socket) {
        connections.delete(socket);
      },
      error(socket, error) {
        log(`connection error: ${error.message}`);
        connections.delete(socket);
      },
    },
  }) as unknown as TCPSocketListener<Connection>;

  return {
    async close() {
      unsubscribe();
      for (const socket of connections) socket.end();
      listener.stop(true);
      await unlink(identity.socketPath).catch(() => {});
    },
  };
}
