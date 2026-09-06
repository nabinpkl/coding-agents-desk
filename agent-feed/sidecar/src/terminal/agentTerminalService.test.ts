import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentTerminalInvalidError,
  AgentTerminalService,
  type AgentTerminalPtyClient,
} from "./agentTerminalService.ts";
import type { PtySessionConnection } from "./ptyClient.ts";

const SESSION_ID = "019c3708-fadb-7e2f-a744-322df224faf4";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test("opens a UUIDv7 Codex session with the deterministic resume command", async () => {
  const home = await mkdtemp(join(tmpdir(), "agent-terminal-home-"));
  roots.push(home);
  const project = join(home, "projects", "agent-desk");
  await mkdir(project, { recursive: true });
  const canonicalProject = await realpath(project);
  const opened: unknown[] = [];
  const connection = {
    attachment: {
      sessionName: `agent-resume-codex-${SESSION_ID}`,
      pid: 42,
      columns: 90,
      rows: 30,
    },
    onEnvelope: () => () => {},
    onFailure: () => () => {},
    requestCheckpoint() {},
    sendInput() {},
    sendBinaryInput() {},
    updateViewerState() {},
    detach() {},
    kill() {},
    closeTransport() {},
  } as unknown as PtySessionConnection;
  const pty: AgentTerminalPtyClient = {
    listSessions: async () => [],
    openSession: async (options) => {
      opened.push(options);
      return connection;
    },
  };
  const service = new AgentTerminalService(
    "/unused/pty.sock",
    () => ({ projectPath: project, activity: "ready" }),
    home,
    pty,
  );

  const descriptor = await service.open({
    kind: "agent-session",
    projectPath: project,
    source: "codex",
    sessionId: SESSION_ID,
  }, { columns: 90, rows: 30 });

  expect(descriptor).toMatchObject({
    ptySessionName: `agent-resume-codex-${SESSION_ID}`,
    pid: 42,
    columns: 90,
    rows: 30,
  });
  expect(opened).toEqual([{
    sessionName: `agent-resume-codex-${SESSION_ID}`,
    launch: {
      cwd: canonicalProject,
      executable: "/bin/zsh",
      arguments: ["-l", "-c", 'exec "$0" "$@"', "codex", "resume", SESSION_ID],
    },
    columns: 90,
    rows: 30,
    createIfMissing: true,
    clientTitle: "Agent Feed",
  }]);
  service.stop();
});

test("an observer sees every terminal, including ones opened after it started", async () => {
  const home = await mkdtemp(join(tmpdir(), "agent-terminal-home-"));
  roots.push(home);
  const project = join(home, "projects", "agent-desk");
  await mkdir(project, { recursive: true });
  const checkpoints: string[] = [];
  const publishers: Array<(envelope: unknown) => void> = [];
  const connection = {
    attachment: {
      sessionName: `agent-resume-codex-${SESSION_ID}`,
      pid: 42,
      columns: 90,
      rows: 30,
    },
    onEnvelope: (listener: (envelope: unknown) => void) => {
      publishers.push(listener);
      return () => {};
    },
    onFailure: () => () => {},
    requestCheckpoint(revision: string) {
      checkpoints.push(revision);
    },
    sendInput() {},
    sendBinaryInput() {},
    updateViewerState() {},
    detach() {},
    kill() {},
    closeTransport() {},
  } as unknown as PtySessionConnection;
  const service = new AgentTerminalService(
    "/unused/pty.sock",
    () => ({ projectPath: project, activity: "ready" }),
    home,
    { listSessions: async () => [], openSession: async () => connection },
  );

  // Registered BEFORE any terminal exists, which is the case a per-terminal listener set could not
  // serve and the reason one HTTP stream can now stand in for a wall of them.
  const seen: unknown[] = [];
  const stop = service.observe((envelope) => seen.push(envelope));
  const descriptor = await service.open(
    { kind: "agent-session", projectPath: project, source: "codex", sessionId: SESSION_ID },
    { columns: 90, rows: 30 },
  );
  for (const emit of publishers) emit({ output: { revision: "4", data: "aGk=" } });

  expect(seen).toEqual([{
    terminalId: descriptor.terminalId,
    message: { type: "output", revision: "4", data: "aGk=" },
  }]);

  // The replay is its own act now, asked for by a viewer rather than implied by the transport.
  expect(checkpoints).toEqual([]);
  service.requestCheckpoint(descriptor.terminalId);
  expect(checkpoints).toEqual(["0"]);

  stop();
  for (const emit of publishers) emit({ output: { revision: "5", data: "aGk=" } });
  expect(seen).toHaveLength(1);
});

test("rejects a non-canonical session id before touching the PTY manager", async () => {
  const pty: AgentTerminalPtyClient = {
    listSessions: async () => { throw new Error("must not be called"); },
    openSession: async () => { throw new Error("must not be called"); },
  };
  const service = new AgentTerminalService(
    "/unused/pty.sock",
    () => undefined,
    "/tmp",
    pty,
  );

  await expect(service.open({
    kind: "agent-session",
    projectPath: "/tmp/project",
    source: "codex",
    sessionId: SESSION_ID.toUpperCase(),
  }, { columns: 80, rows: 24 })).rejects.toBeInstanceOf(AgentTerminalInvalidError);
});

test("attaches to a tmux session rather than resuming a CLI", async () => {
  const opened: unknown[] = [];
  const home = await mkdtemp(join(tmpdir(), "agent-terminal-home-"));
  roots.push(home);
  const connection = {
    attachment: { sessionName: "agent-tmux-canvas-fork", pid: 7, columns: 120, rows: 40 },
    onEnvelope: () => () => {},
    onFailure: () => () => {},
    requestCheckpoint() {},
    sendInput() {},
    sendBinaryInput() {},
    updateViewerState() {},
    detach() {},
    kill() {},
    closeTransport() {},
  } as unknown as PtySessionConnection;
  const service = new AgentTerminalService(
    "/unused/pty.sock",
    // No catalog lookup happens for a tmux target: it is a process on the machine, not a
    // transcript, and refusing it because no agent session matches would refuse the whole point.
    () => undefined,
    home,
    {
      listSessions: async () => [],
      openSession: async (options) => {
        opened.push(options);
        return connection;
      },
    },
  );

  const descriptor = await service.open(
    { kind: "tmux", session: "canvas-fork" },
    { columns: 120, rows: 40 },
  );

  expect(descriptor.ptySessionName).toBe("agent-tmux-canvas-fork");
  expect(opened).toEqual([{
    sessionName: "agent-tmux-canvas-fork",
    launch: {
      cwd: home,
      executable: "/bin/zsh",
      arguments: ["-l", "-c", 'exec "$0" "$@"', "tmux", "attach-session", "-t", "canvas-fork"],
    },
    columns: 120,
    rows: 40,
    createIfMissing: true,
    clientTitle: "Agent Feed",
  }]);
});

test("refuses a tmux name that is not a plain identifier", async () => {
  const home = await mkdtemp(join(tmpdir(), "agent-terminal-home-"));
  roots.push(home);
  const service = new AgentTerminalService(
    "/unused/pty.sock",
    () => undefined,
    home,
    { listSessions: async () => [], openSession: async () => { throw new Error("unreached"); } },
  );

  // The name reaches a shell argument list, so anything but an identifier is refused before it
  // gets there rather than quoted and hoped for.
  for (const session of ["", "a b", "one;rm -rf /", "$(whoami)", "../escape"]) {
    await expect(service.open({ kind: "tmux", session }, { columns: 80, rows: 24 }))
      .rejects.toBeInstanceOf(AgentTerminalInvalidError);
  }
});
