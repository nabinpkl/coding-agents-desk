// Attaching a viewer to a tmux pane instead of resuming a CLI, and what a second viewer
// of the same pane is owed.

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

test("attaches to a window or pane target, refusing anything wilder", async () => {
  const home = await mkdtemp(join(tmpdir(), "agent-terminal-home-"));
  roots.push(home);
  const attached: { session: string; columns: number; rows: number }[] = [];
  const mouseRestored: string[] = [];
  const service = serviceWithTmux(
    new AgentTerminalService(
      "/unused/pty.sock",
      () => undefined,
      home,
      { listSessions: async () => [], openSession: async () => { throw new Error("no PTY here"); } },
      async () => "",
      async (session) => { mouseRestored.push(session); },
    ),
    attached,
  );

  await service.open({ kind: "tmux", session: "canvas-fork:1" }, { columns: 120, rows: 40 });
  await service.open({ kind: "tmux", session: "canvas-fork:1.2" }, { columns: 120, rows: 40 });
  expect(attached).toEqual([
    { session: "canvas-fork:1", columns: 120, rows: 40 },
    { session: "canvas-fork:1.2", columns: 120, rows: 40 },
  ]);
  // `mouse` is a session option, so the restore strips the window and pane halves.
  expect(mouseRestored).toEqual(["canvas-fork", "canvas-fork"]);
  await expect(service.open({ kind: "tmux", session: "canvas-fork:1.x" }, { columns: 80, rows: 24 }))
    .rejects.toBeInstanceOf(AgentTerminalInvalidError);
  await expect(service.open({ kind: "tmux", session: "../evil" }, { columns: 80, rows: 24 }))
    .rejects.toBeInstanceOf(AgentTerminalInvalidError);
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
  // Through a recording tmux, not the machine's: without this the attach reaches the real tmux and
  // the test passes only where a session called `canvas-fork` happens to exist. It did when this
  // was written and did not an hour later, which reads as a code regression rather than as a test
  // asking the wrong thing.
  const service = serviceWithTmux(
    new AgentTerminalService(
      "/unused/pty.sock",
      () => undefined,
      home,
      { listSessions: async () => [], openSession: async () => connection },
      async (session, lines) => {
        asked.push({ capture: { session, lines } });
        return "earlier bytes\n";
      },
      async (session) => { asked.push({ mouseRestored: session }); },
    ),
    [],
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
    () => ({ projectPath: project, activity: "ready", title: "Source session" }),
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

test("starts a login shell in the directory when the session is not running", async () => {
  const attached: { session: string; columns: number; rows: number }[] = [];
  const fakes: SessionTmuxFakes = { owner: null, running: new Set(), created: [], settled: [] };
  const { service, project } = await sessionTmuxFixture(fakes, attached);

  const descriptor = await service.open(
    { kind: "tmux-new", session: "agentterm-1a2b3c4d", directory: project },
    { columns: 100, rows: 30 },
  );

  // The one thing this kind does that a plain tmux target does not: start the session it names,
  // as a login shell in the vouched directory, at the viewer's own geometry. A second viewer
  // of the same name lands on it rather than starting another.
  expect(fakes.created).toEqual([{
    session: "agentterm-1a2b3c4d",
    cwd: await realpath(project),
    command: [],
    columns: 100,
    rows: 30,
  }]);
  expect(fakes.settled).toEqual(["agentterm-1a2b3c4d"]);
  expect(attached).toEqual([{ session: "agentterm-1a2b3c4d", columns: 100, rows: 30 }]);
  expect(descriptor.ptySessionName).toBe("agent-tmux-agentterm-1a2b3c4d");
});

test("joins a tmux-new session that is already running instead of starting a second", async () => {
  const attached: { session: string; columns: number; rows: number }[] = [];
  const fakes: SessionTmuxFakes = {
    owner: null,
    running: new Set(["agentterm-1a2b3c4d"]),
    created: [],
  };
  const { service, project } = await sessionTmuxFixture(fakes, attached);

  await service.open(
    { kind: "tmux-new", session: "agentterm-1a2b3c4d", directory: project },
    { columns: 100, rows: 30 },
  );

  // Both the sidecar's existence check and tmux's own `-A` land a collision on the running
  // session, so two opens of one name are two viewers, never two shells.
  expect(fakes.created).toEqual([]);
  expect(attached).toEqual([{ session: "agentterm-1a2b3c4d", columns: 100, rows: 30 }]);
});

test("a tmux-new open vouches for its name and its directory", async () => {
  const attached: { session: string; columns: number; rows: number }[] = [];
  const fakes: SessionTmuxFakes = { owner: null, running: new Set(), created: [] };
  const { service, project } = await sessionTmuxFixture(fakes, attached);

  // The name reaches tmux as `-s`, the directory as `-c`, so both are refused at the door.
  for (const session of ["", "a b", "../escape"]) {
    await expect(service.open({ kind: "tmux-new", session, directory: project }, { columns: 80, rows: 24 }))
      .rejects.toBeInstanceOf(AgentTerminalInvalidError);
  }
  for (const directory of ["/tmp", join(project, "missing"), "relative/path"]) {
    await expect(
      service.open({ kind: "tmux-new", session: "agentterm-1a2b3c4d", directory }, { columns: 80, rows: 24 }),
    ).rejects.toBeInstanceOf(AgentTerminalInvalidError);
  }
  expect(fakes.created).toEqual([]);
  expect(attached).toEqual([]);
});
