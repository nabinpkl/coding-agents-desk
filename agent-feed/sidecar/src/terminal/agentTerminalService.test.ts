// Opening a terminal for an agent session by resuming its CLI.

import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentTerminalInvalidError,
  AgentTerminalService,
  liveTmuxSession,
  type AgentTerminalPtyClient,
} from "@/terminal/agentTerminalService";
import type { PtySessionConnection } from "@/terminal/pty/ptyClient";
import type { TmuxAttachments, TmuxSessionConnection } from "@/terminal/tmux/tmuxAttachment";
import {
  agentTerminalHarness,
  SESSION_ID,
  type SessionTmuxFakes,
} from "@/terminal/agentTerminalHarness";

const {
  roots,
  serviceWithTmux,
  sessionTmuxFixture,
  sessionTmuxService,
  tmuxConnection,
} = agentTerminalHarness();

test("opens a UUIDv7 Codex session with the deterministic resume command", async () => {
  const home = await mkdtemp(join(tmpdir(), "agent-terminal-home-"));
  roots.push(home);
  const project = join(home, "projects", "agent-desk");
  await mkdir(project, { recursive: true });
  const canonicalProject = await realpath(project);
  const opened: unknown[] = [];
  const connection = {
    attachment: {
      sessionName: `agent-shell-codex-${SESSION_ID}`,
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
    () => ({ projectPath: project, activity: "ready", title: "Source session" }),
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
    ptySessionName: `agent-shell-codex-${SESSION_ID}`,
    pid: 42,
    columns: 90,
    rows: 30,
  });
  expect(opened).toEqual([{
    sessionName: `agent-shell-codex-${SESSION_ID}`,
    launch: {
      cwd: canonicalProject,
      executable: "/bin/zsh",
      // A shell, not `codex resume`: the control opens a terminal in the session's directory, and
      // a live session used to be refused outright rather than given one.
      arguments: ["-l"],
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
      sessionName: `agent-shell-codex-${SESSION_ID}`,
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
    () => ({ projectPath: project, activity: "ready", title: "Source session" }),
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

test("opens a workspace shell in the root, under one name per directory", async () => {
  const home = await mkdtemp(join(tmpdir(), "agent-terminal-home-"));
  roots.push(home);
  const root = join(home, "projects", "agent-desk");
  await mkdir(root, { recursive: true });
  const canonicalRoot = await realpath(root);
  const opened: { sessionName: string; launch: { cwd: string; arguments: string[] } }[] = [];
  const pty: AgentTerminalPtyClient = {
    listSessions: async () => [],
    openSession: async (options) => {
      opened.push(options as (typeof opened)[number]);
      return {
        attachment: { sessionName: options.sessionName, pid: 7, columns: 100, rows: 30 },
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
    },
  };
  const service = new AgentTerminalService(
    "/unused/pty.sock",
    () => undefined,
    home,
    pty,
  );

  const first = await service.open(
    { kind: "workspace", workspacePath: root },
    { columns: 100, rows: 30 },
  );
  const second = await service.open(
    { kind: "workspace", workspacePath: root },
    { columns: 100, rows: 30 },
  );

  // The login shell itself, in the workspace, with nothing to exec: this terminal is a place to
  // work rather than a CLI being resumed.
  expect(opened[0]).toMatchObject({
    launch: { cwd: canonicalRoot, executable: "/bin/zsh", arguments: ["-l"] },
  });
  // Named after the directory so a reader recognises it, and the same name both times so the
  // second tab to open this workspace joins the shell the first one started.
  expect(first.ptySessionName).toMatch(/^agent-workspace-agent-desk-[0-9a-f]{8}$/);
  expect(second.ptySessionName).toBe(first.ptySessionName);
  // Two terminals, one session: each viewer gets its own id and they share the far end.
  expect(second.terminalId).not.toBe(first.terminalId);
  service.stop();
});

test("refuses a workspace shell outside the user home", async () => {
  const home = await mkdtemp(join(tmpdir(), "agent-terminal-home-"));
  const elsewhere = await mkdtemp(join(tmpdir(), "agent-terminal-elsewhere-"));
  roots.push(home, elsewhere);
  const service = new AgentTerminalService(
    "/unused/pty.sock",
    () => undefined,
    home,
    { listSessions: async () => [], openSession: async () => { throw new Error("unreached"); } },
  );

  // The panel only ever sends a root it has registered, and the sidecar does not take its word
  // for it: the panel is a browser tab, and this is what keeps `/api/terminals` from being a
  // shell anywhere on the machine.
  await expect(
    service.open({ kind: "workspace", workspacePath: elsewhere }, { columns: 80, rows: 24 }),
  ).rejects.toBeInstanceOf(AgentTerminalInvalidError);
  service.stop();
});

test("opens a machine shell in the home, under one name for the machine", async () => {
  const home = await mkdtemp(join(tmpdir(), "agent-terminal-home-"));
  roots.push(home);
  const canonicalHome = await realpath(home);
  const opened: { sessionName: string; launch: { cwd: string; arguments: string[] } }[] = [];
  const pty: AgentTerminalPtyClient = {
    listSessions: async () => [],
    openSession: async (options) => {
      opened.push(options as (typeof opened)[number]);
      return {
        attachment: { sessionName: options.sessionName, pid: 7, columns: 100, rows: 30 },
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
    },
  };
  const service = new AgentTerminalService("/unused/pty.sock", () => undefined, home, pty);

  const first = await service.open({ kind: "machine" }, { columns: 100, rows: 30 });
  const second = await service.open({ kind: "machine" }, { columns: 100, rows: 30 });

  // The home itself, which the workspace kind refuses: the panel sent no path, so there is
  // nothing to vouch for, and the sidecar's own home is what "this machine" means.
  expect(opened[0]).toMatchObject({
    launch: { cwd: canonicalHome, executable: "/bin/zsh", arguments: ["-l"] },
  });
  // Not tmux: a PTY session of the panel's own, and one per machine so a second tab joins it.
  expect(first.ptySessionName).toBe("agent-machine-shell");
  expect(second.ptySessionName).toBe(first.ptySessionName);
  expect(second.terminalId).not.toBe(first.terminalId);
  service.stop();
});
