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
    projectPath: "/tmp/project",
    source: "codex",
    sessionId: SESSION_ID.toUpperCase(),
  }, { columns: 80, rows: 24 })).rejects.toBeInstanceOf(AgentTerminalInvalidError);
});
