import { describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:net";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { CommandRunner } from "../tasks/processProbe.ts";
import {
  cliInputStatus,
  deliverCliInput,
  encodeInboxPayload,
  inboxKeyFileName,
  resolveInbox,
} from "./claudeSessionInbox.ts";

const SESSION = "2adc3708-fadb-4e2f-a744-322df224faf4";
const TOKEN = "0123456789abcdef0123456789abcdef";
const PROC_START = "Fri Aug 14 17:10:48 2026";

/**
 * The ctime string the kernel prints locally for the same instant the registry records in UTC.
 * Built rather than written down so these hold in any timezone.
 */
const KERNEL_STAMP = (() => {
  const at = new Date(Date.UTC(2026, 7, 14, 17, 10, 48));
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${days[at.getDay()]} ${months[at.getMonth()]} ${String(at.getDate()).padStart(2, " ")} ` +
    `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())} ${at.getFullYear()}`;
})();

const alive: CommandRunner = async () => KERNEL_STAMP;

interface Registry {
  directory: string;
  socketPath: string;
}

/** A registry directory holding one live session, with whichever pieces the test wants present. */
async function registry(options: {
  socket?: boolean;
  key?: boolean;
  keyBody?: unknown;
  entrypoint?: string;
  pid?: number;
} = {}): Promise<Registry> {
  const directory = await mkdtemp(join("/tmp", "adz-inbox-"));
  const pid = options.pid ?? 9672;
  // Short and under /tmp: a unix socket path over ~104 bytes cannot be bound at all, and
  // $TMPDIR on macOS is long enough to blow that on its own.
  const socketPath = join(directory, "s.sock");
  await writeFile(
    join(directory, `${pid}.json`),
    JSON.stringify({
      pid,
      sessionId: SESSION,
      cwd: "/x",
      procStart: PROC_START,
      entrypoint: options.entrypoint ?? "cli",
      ...(options.socket === false ? {} : { messagingSocketPath: socketPath }),
    }),
  );
  if (options.key !== false) {
    await writeFile(
      join(directory, inboxKeyFileName(pid, socketPath)),
      JSON.stringify(options.keyBody ?? { peerToken: TOKEN, procStart: PROC_START }),
    );
  }
  return { directory, socketPath };
}

/** A stand-in inbox that records the lines it was handed and then closes, as the harness does. */
function inboxServer(path: string): { server: Server; lines: Promise<string[]> } {
  const server = createServer({ allowHalfOpen: true });
  const lines = new Promise<string[]>((resolveWith) => {
    server.on("connection", (socket) => {
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += String(chunk);
      });
      socket.on("end", () => {
        socket.end();
        resolveWith(buffer.split("\n").filter((line) => line !== ""));
      });
    });
  });
  server.listen(path);
  return { server, lines };
}

describe("inboxKeyFileName", () => {
  test("names the key by the socket it unlocks, not by the pid alone", () => {
    const name = inboxKeyFileName(9672, "/tmp/cc-socks/9672.sock");
    const digest = createHash("sha256").update("/tmp/cc-socks/9672.sock").digest("hex");
    expect(name).toBe(`9672.${digest}.key`);
  });

  test("two sockets under one pid derive different key names", () => {
    // The reason the hash is in the name at all: a pid can be reused, a socket path cannot be
    // confused, and picking a key by pid alone would hand one session's token to another's inbox.
    expect(inboxKeyFileName(9672, "/tmp/a.sock")).not.toBe(inboxKeyFileName(9672, "/tmp/b.sock"));
  });

  test("a relative path is canonicalised, because the harness hashes the resolved one", () => {
    expect(inboxKeyFileName(1, `${process.cwd()}/x.sock`)).toBe(inboxKeyFileName(1, "./x.sock"));
  });
});

describe("encodeInboxPayload", () => {
  test("is the harness's two lines, auth first, newline-terminated", () => {
    const lines = encodeInboxPayload(TOKEN, SESSION, "hello").split("\n");
    expect(JSON.parse(lines[0]!)).toEqual({ type: "auth", token: TOKEN });
    expect(JSON.parse(lines[1]!)).toEqual({
      type: "user",
      session_id: SESSION,
      message: { role: "user", content: "hello" },
    });
    // The trailing newline is load-bearing: the reader parses on line boundaries, and a final
    // line with no terminator is only parsed if the peer also sees the stream end.
    expect(lines[2]).toBe("");
  });

  test("names the session, so the receiver drops a turn meant for another one", () => {
    // The one check we do not make ourselves. Our own verification proves the pid; only this
    // proves the session, and the harness ignores a frame that does not carry it.
    const line = JSON.parse(encodeInboxPayload(TOKEN, SESSION, "hello").split("\n")[1]!);
    expect(line.session_id).toBe(SESSION);
  });

  test("a turn containing newlines stays one line on the wire", () => {
    const lines = encodeInboxPayload(TOKEN, SESSION, "first\nsecond").split("\n");
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[1]!).message.content).toBe("first\nsecond");
  });
});

describe("resolveInbox", () => {
  test("finds the socket and the token for a live session", async () => {
    const { directory, socketPath } = await registry();
    const resolved = await resolveInbox(SESSION, alive, directory);
    expect(resolved.kind).toBe("ready");
    if (resolved.kind !== "ready") return;
    expect(resolved.target.socketPath).toBe(socketPath);
    expect(resolved.target.token).toBe(TOKEN);
    expect(resolved.target.owner.entrypoint).toBe("cli");
  });

  test("a session nothing is running reports not-running and names no entrypoint", async () => {
    const { directory } = await registry();
    const dead: CommandRunner = async () => "";
    expect(await resolveInbox(SESSION, dead, directory)).toEqual({
      kind: "unavailable",
      reason: "not-running",
      owner: null,
    });
  });

  test("a live session with no socket keeps its owner, so the panel can say which kind", async () => {
    const { directory } = await registry({ socket: false, entrypoint: "claude-desktop" });
    const resolved = await resolveInbox(SESSION, alive, directory);
    expect(resolved.kind).toBe("unavailable");
    if (resolved.kind !== "unavailable") return;
    expect(resolved.reason).toBe("no-inbox");
    expect(resolved.owner?.entrypoint).toBe("claude-desktop");
  });

  test("a swept key is no-key rather than an unauthenticated send", async () => {
    const { directory } = await registry({ key: false });
    const resolved = await resolveInbox(SESSION, alive, directory);
    expect(resolved.kind === "unavailable" && resolved.reason).toBe("no-key");
  });

  test("a key whose procStart disagrees is refused, which is the pid-reuse defence", async () => {
    const { directory } = await registry({
      keyBody: { peerToken: TOKEN, procStart: "Fri Aug 14 18:10:48 2026" },
    });
    const resolved = await resolveInbox(SESSION, alive, directory);
    expect(resolved.kind === "unavailable" && resolved.reason).toBe("no-key");
  });

  test("a token that is not a token is refused rather than sent", async () => {
    const { directory } = await registry({ keyBody: { peerToken: "nope", procStart: PROC_START } });
    const resolved = await resolveInbox(SESSION, alive, directory);
    expect(resolved.kind === "unavailable" && resolved.reason).toBe("no-key");
  });
});

describe("cliInputStatus", () => {
  test("says available and names the entrypoint", async () => {
    const { directory } = await registry();
    expect(await cliInputStatus(SESSION, alive, directory)).toEqual({
      available: true,
      entrypoint: "cli",
      reason: null,
    });
  });

  test("a desktop session with an inbox is available too, and says which it is", async () => {
    // Reported honestly rather than filtered here. The inbox exists for both launch surfaces;
    // which composer to show is the panel's decision, and it needs the fact to make it.
    const { directory } = await registry({ entrypoint: "claude-desktop" });
    expect(await cliInputStatus(SESSION, alive, directory)).toEqual({
      available: true,
      entrypoint: "claude-desktop",
      reason: null,
    });
  });

  test("nothing running answers with a reason and no entrypoint", async () => {
    const { directory } = await registry();
    expect(await cliInputStatus(SESSION, async () => "", directory)).toEqual({
      available: false,
      entrypoint: null,
      reason: "not-running",
    });
  });
});

describe("deliverCliInput", () => {
  test("hands both lines to the session's socket", async () => {
    const { directory, socketPath } = await registry();
    const { server, lines } = inboxServer(socketPath);
    try {
      expect(await deliverCliInput(SESSION, "ship it", alive, directory)).toEqual({
        delivered: true,
        reason: null,
      });
      const received = await lines;
      expect(JSON.parse(received[0]!)).toEqual({ type: "auth", token: TOKEN });
      expect(JSON.parse(received[1]!).session_id).toBe(SESSION);
      expect(JSON.parse(received[1]!).message.content).toBe("ship it");
    } finally {
      server.close();
    }
  });

  test("a socket file with nothing listening is unreachable, not a hang", async () => {
    // The state a crashed session leaves behind, and the one the registry row cannot tell you
    // about: the row and the key are both still on disk.
    const { directory } = await registry();
    expect(await deliverCliInput(SESSION, "hello", alive, directory)).toEqual({
      delivered: false,
      reason: "unreachable",
    });
  });

  test("refuses before connecting when there is no inbox to connect to", async () => {
    const { directory } = await registry({ socket: false });
    expect(await deliverCliInput(SESSION, "hello", alive, directory)).toEqual({
      delivered: false,
      reason: "no-inbox",
    });
  });
});
