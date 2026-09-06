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
import type { TmuxAttachments, TmuxSessionConnection } from "./tmuxAttachment.ts";

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

/** A tmux-backed connection that records what the service asked of it. */
function tmuxConnection(acts: string[]) {
  return {
    attachment: { sessionName: "canvas-fork", pid: 7, columns: 80, rows: 24 },
    onEnvelope: () => () => {},
    onFailure: () => () => {},
    requestCheckpoint() {},
    sendInput() {},
    sendBinaryInput() {},
    updateViewerState() {},
    detach() { acts.push("detach"); },
    kill() { acts.push("detach"); },
    closeTransport() {},
  } as unknown as TmuxSessionConnection;
}

/** Points a service built for the PTY path at a recording tmux backend instead. */
function serviceWithTmux(
  service: AgentTerminalService,
  attached: { session: string; columns: number; rows: number }[],
): AgentTerminalService {
  (service as unknown as { tmux: { open: TmuxAttachments["open"] } }).tmux = {
    open: async (session, dimensions) => {
      attached.push({ session, ...dimensions });
      return tmuxConnection([]);
    },
  };
  return service;
}

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

  const attached: { session: string; columns: number; rows: number }[] = [];
  const descriptor = await serviceWithTmux(service, attached).open(
    { kind: "tmux", session: "canvas-fork" },
    { columns: 120, rows: 40 },
  );

  // A tmux target never reaches the PTY daemon: nothing has to be launched, because the session is
  // already running and owned by whoever started it. Asking a daemon that may not be installed to
  // attach it is how a machine with tmux and no daemon lists sessions it cannot open.
  expect(opened).toEqual([]);
  expect(attached).toEqual([{ session: "canvas-fork", columns: 120, rows: 40 }]);
  expect(descriptor.ptySessionName).toBe("agent-tmux-canvas-fork");
});

test("a viewer leaving a shared tmux attach never ends the session", async () => {
  const home = await mkdtemp(join(tmpdir(), "agent-terminal-home-"));
  roots.push(home);
  const acts: string[] = [];
  const service = new AgentTerminalService(
    "/unused/pty.sock",
    () => undefined,
    home,
    { listSessions: async () => [], openSession: async () => { throw new Error("no PTY here"); } },
    async () => "",
    async () => {},
    { open: async () => tmuxConnection(acts) },
  );

  const context = { kind: "tmux" as const, session: "canvas-fork" };
  const first = await service.open(context, { columns: 80, rows: 24 });
  const second = await service.open(context, { columns: 80, rows: 24 });
  expect(first.ptySessionName).toBe(second.ptySessionName);

  // "kill" is the viewer's word for closing its tile. On this backend it can only ever stop the
  // pipe, because the tmux session is the owner's work and a closing browser tab is not a reason
  // to end it. Both viewers leaving must still leave the session alone.
  service.close(first.terminalId, "kill");
  service.close(second.terminalId, "kill");
  expect(acts).toEqual(["detach", "detach"]);
});

test("takes the wheel back from tmux and hands over the pane's history", async () => {
  const home = await mkdtemp(join(tmpdir(), "agent-terminal-home-"));
  roots.push(home);
  const asked: unknown[] = [];
  const connection = {
    attachment: { sessionName: "agent-tmux-canvas-fork", pid: 7, columns: 80, rows: 24 },
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
    () => undefined,
    home,
    { listSessions: async () => [], openSession: async () => connection },
    async (session, lines) => {
      asked.push({ capture: { session, lines } });
      return "earlier bytes\n";
    },
    async (session) => { asked.push({ mouseRestored: session }); },
  );

  const descriptor = await service.open(
    { kind: "tmux", session: "canvas-fork" },
    { columns: 80, rows: 24 },
  );
  // `mouse` is a session option with no per-client form, so a tile that forced it off took
  // copy-mode and mouse selection from every other client of the session. Opening now releases the
  // option instead, which is the one direction that cannot surprise another client.
  await Promise.resolve();
  expect(asked).toEqual([{ mouseRestored: "canvas-fork" }]);

  expect(await service.history(descriptor.terminalId, 2_000)).toBe("earlier bytes\n");
  expect(asked).toEqual([
    { mouseRestored: "canvas-fork" },
    { capture: { session: "canvas-fork", lines: 2_000 } },
  ]);
});

test("a resumed CLI has no tmux history to hand over", async () => {
  const home = await mkdtemp(join(tmpdir(), "agent-terminal-home-"));
  roots.push(home);
  const project = join(home, "projects", "agent-desk");
  await mkdir(project, { recursive: true });
  const asked: unknown[] = [];
  const connection = {
    attachment: { sessionName: `agent-shell-codex-${SESSION_ID}`, pid: 7, columns: 80, rows: 24 },
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
    () => ({ projectPath: project, activity: "ready" }),
    home,
    { listSessions: async () => [], openSession: async () => connection },
    async () => { asked.push("captured"); return "should not happen\n"; },
    async () => { asked.push("mouseRestored"); },
  );

  const descriptor = await service.open(
    { kind: "agent-session", projectPath: project, source: "codex", sessionId: SESSION_ID },
    { columns: 80, rows: 24 },
  );

  // Its screen comes from the PTY manager's own replay; there is no tmux behind it to ask, and no
  // mouse setting of anyone else's to touch.
  expect(await service.history(descriptor.terminalId, 2_000)).toBe("");
  expect(asked).toEqual([]);
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
