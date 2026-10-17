// The runner's side of the socket: one session's state out, the sidecar's commands in.
//
// Any number of connections, because more than one sidecar can be looking -- the one that started
// the runner, the one it restarted into, a second panel's. Each is sent `hello` and the whole state
// the moment it connects, and the whole state again on every change, so a sidecar that missed
// everything while it restarted is current from its first read.

import { lstat, mkdir, unlink } from "node:fs/promises";
import type { Socket, TCPSocketListener } from "bun";
import type { ClaudeSdkRunner } from "@/claude-sdk/claudeSdkRunner";
import {
  encodeLine,
  LineReader,
  parseSidecarMessage,
  PROTOCOL_VERSION,
  type RunnerReply,
  type RunnerToSidecar,
  type SidecarToRunner,
} from "@/claude-sdk/claudeSdkProtocol";

interface Connection {
  reader: LineReader;
  /** Bytes the kernel has not taken yet; flushed on `drain`. */
  backlog: Buffer;
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
  identity: { sessionId: string; socketPath: string },
  log: (line: string) => void,
): Promise<RunnerServer> {
  await claimSocketPath(identity.socketPath);
  const connections = new Set<Socket<Connection>>();

  const send = (socket: Socket<Connection>, message: RunnerToSidecar): void => {
    const data = socket.data;
    data.backlog = Buffer.concat([data.backlog, Buffer.from(encodeLine(message))]);
    flush(socket);
  };
  // Cut by bytes, never by characters: a partial write can stop inside a multi-byte one.
  const flush = (socket: Socket<Connection>): void => {
    const data = socket.data;
    if (data.backlog.length === 0) return;
    const written = socket.write(data.backlog);
    data.backlog = written >= data.backlog.length ? Buffer.alloc(0) : data.backlog.subarray(Math.max(0, written));
  };

  const unsubscribe = runner.subscribe((state) => {
    for (const socket of connections) if (socket.data.greeted) send(socket, { type: "state", state });
  });

  const execute = async (message: Exclude<SidecarToRunner, { type: "hello" }>): Promise<RunnerReply> => {
    switch (message.type) {
      case "prompt":
        return runner.prompt(message.text);
      case "answer":
        return runner.answer(message.answers);
      case "decide":
        return runner.decide(message.toolUseId, message.allow, message.message);
      case "set-mode":
        return runner.setMode(message.mode);
      case "interrupt":
        return runner.interrupt();
      case "stop":
        await runner.stop();
        return { ok: true };
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
      send(socket, { type: "state", state: runner.state() });
      return;
    }
    if (!socket.data.greeted) {
      log("dropped a command sent before hello");
      return;
    }
    void execute(message).then(
      (reply) => send(socket, { type: "reply", id: message.id, reply }),
      (error: unknown) => send(socket, {
        type: "reply",
        id: message.id,
        reply: { ok: false, reason: "failed", message: error instanceof Error ? error.message : String(error) },
      }),
    );
  };

  const listener: TCPSocketListener<Connection> = Bun.listen<Connection>({
    unix: identity.socketPath,
    socket: {
      open(socket) {
        socket.data = { reader: new LineReader(), backlog: Buffer.alloc(0), greeted: false };
        connections.add(socket);
        send(socket, { type: "hello", version: PROTOCOL_VERSION, sessionId: identity.sessionId, pid: process.pid });
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
        flush(socket);
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
