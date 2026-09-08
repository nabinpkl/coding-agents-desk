import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentTerminalInvalidError,
  AgentTerminalService,
  liveTmuxSession,
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

interface SessionTmuxFakes {
  /** The pane a live process for the session claims, or null for "nothing is running it". */
  owner: string | null;
  running: Set<string>;
  created: {
    session: string;
    cwd: string;
    command: readonly string[];
    columns: number;
    rows: number;
  }[];
  /** Panes this open waited on before attaching, in order. */
  settled?: string[];
}

/** Points the session-to-pane resolution at recording fakes, the way `serviceWithTmux` does. */
function serviceWithSessionTmux(
  service: AgentTerminalService,
  fakes: SessionTmuxFakes,
): AgentTerminalService {
  (service as unknown as { sessionTmux: unknown }).sessionTmux = {
    owner: async () => fakes.owner,
    exists: async (session: string) => fakes.running.has(session),
    create: async (options: SessionTmuxFakes["created"][number]) => {
      fakes.created.push(options);
      fakes.running.add(options.session);
    },
    settle: async (session: string) => {
      fakes.settled?.push(session);
    },
  };
  return service;
}

/**
 * The fixture above, plus the project directory it made.
 *
 * `session-new` is the one kind handed a directory rather than resolving one from a session, so a
 * test of it has to know which directory this fixture created. Split rather than changed in place
 * so the dozen tests that only want the service keep reading as they did.
 */
async function sessionTmuxFixture(
  fakes: SessionTmuxFakes,
  attached: { session: string; columns: number; rows: number }[],
): Promise<{ service: AgentTerminalService; project: string }> {
  const home = await mkdtemp(join(tmpdir(), "agent-terminal-home-"));
  roots.push(home);
  const project = join(home, "projects", "agent-desk");
  await mkdir(project, { recursive: true });
  const service = new AgentTerminalService(
    "/unused/pty.sock",
    () => ({ projectPath: project, activity: "live", title: "Source session" }),
    home,
    { listSessions: async () => [], openSession: async () => { throw new Error("unreached"); } },
    async () => "",
    async () => {},
  );
  return {
    service: serviceWithSessionTmux(serviceWithTmux(service, attached), fakes),
    project,
  };
}

async function sessionTmuxService(
  fakes: SessionTmuxFakes,
  attached: { session: string; columns: number; rows: number }[],
): Promise<AgentTerminalService> {
  return (await sessionTmuxFixture(fakes, attached)).service;
}

test("joins the tmux session a live agent session is already running in", async () => {
  const fakes: SessionTmuxFakes = { owner: "composerprobe", running: new Set(), created: [] };
  const attached: { session: string; columns: number; rows: number }[] = [];
  const service = await sessionTmuxService(fakes, attached);

  const descriptor = await service.open(
    { kind: "session-tmux", source: "claude", sessionId: SESSION_ID },
    { columns: 100, rows: 30 },
  );

  expect(attached).toEqual([{ session: "composerprobe", columns: 100, rows: 30 }]);
  // Nothing started: that pane belongs to whoever is running the session, and resuming a live
  // transcript a second time is the thing this path exists to avoid.
  expect(fakes.created).toEqual([]);
  expect(descriptor.ptySessionName).toBe("agent-tmux-composerprobe");
});

test("starts a tmux session that resumes the agent session when nothing is running it", async () => {
  const fakes: SessionTmuxFakes = { owner: null, running: new Set(), created: [] };
  const attached: { session: string; columns: number; rows: number }[] = [];
  const service = await sessionTmuxService(fakes, attached);

  await service.open(
    { kind: "session-tmux", source: "claude", sessionId: SESSION_ID },
    { columns: 100, rows: 30 },
  );

  // At the viewer's geometry, because this session has no other client to take a size from.
  expect(fakes.created).toEqual([{
    session: `agentdesk-${SESSION_ID}`,
    cwd: expect.stringContaining("projects/agent-desk"),
    command: ["claude", "--resume", SESSION_ID],
    columns: 100,
    rows: 30,
  }]);
  expect(attached).toEqual([{ session: `agentdesk-${SESSION_ID}`, columns: 100, rows: 30 }]);
});

const FORK_ID = "9f0c5d5a-6c53-4b2a-9d8e-2f7c1a4b6e30";
/** What the reader called it in the dialog. The service takes this and derives nothing. */
const FORK_TITLE = "Source session (fork 2)";

test("forks a session into a pane of its own, never joining the one it came from", async () => {
  // The source session IS running in a pane. The resume path would join that pane; a fork must
  // not, or the reader lands back in the transcript they asked to branch away from.
  const fakes: SessionTmuxFakes = { owner: "composerprobe", running: new Set(), created: [] };
  const attached: { session: string; columns: number; rows: number }[] = [];
  const service = await sessionTmuxService(fakes, attached);

  await service.open(
    { kind: "session-fork", source: "claude", sessionId: SESSION_ID, forkId: FORK_ID, title: FORK_TITLE },
    { columns: 100, rows: 30 },
  );

  expect(fakes.created).toEqual([{
    session: `agentdesk-fork-${FORK_ID}`,
    cwd: expect.stringContaining("projects/agent-desk"),
    command: [
      "claude",
      "--resume",
      SESSION_ID,
      "--fork-session",
      "--session-id",
      FORK_ID,
      "-n",
      FORK_TITLE,
    ],
    columns: 100,
    rows: 30,
  }]);
  expect(attached).toEqual([{ session: `agentdesk-fork-${FORK_ID}`, columns: 100, rows: 30 }]);
});

test("refuses a fork title it cannot pass to the CLI, rather than substituting one", async () => {
  // The reader types this, so it can be anything. A blank field and a title past the catalog's
  // cap are both refused here: naming one for them would start a session under a name they did
  // not choose and cannot see until it has taken a turn.
  const fakes: SessionTmuxFakes = { owner: null, running: new Set(), created: [] };
  const service = await sessionTmuxService(fakes, []);
  const fork = (title: string) => service.open(
    { kind: "session-fork" as const, source: "claude" as const, sessionId: SESSION_ID, forkId: FORK_ID, title },
    { columns: 100, rows: 30 },
  );

  await expect(fork("   ")).rejects.toThrow(/cannot be empty/);
  await expect(fork("x".repeat(241))).rejects.toThrow(/cannot exceed/);
  await expect(fork("two\nlines")).rejects.toThrow(/line break/);
  expect(fakes.created).toEqual([]);
});

test("reports the name it was given for the session it started, since nothing else can be asked yet", async () => {
  // Until the fork's first turn there is no transcript, so the caller has nowhere to read this
  // from. The descriptor is the only moment the chosen name exists anywhere the panel can see it.
  const fakes: SessionTmuxFakes = { owner: null, running: new Set(), created: [] };
  const service = await sessionTmuxService(fakes, []);

  const descriptor = await service.open(
    { kind: "session-fork", source: "claude", sessionId: SESSION_ID, forkId: FORK_ID, title: FORK_TITLE },
    { columns: 100, rows: 30 },
  );

  expect(descriptor.startedSession).toEqual({ sessionId: FORK_ID, title: FORK_TITLE });
});

test("reports no started session on a second open of one fork, which starts nothing", async () => {
  // A second open of a fork that is already running joins its pane. Reporting a started session
  // there would tell the panel to name and attach a session this call did not create.
  const fakes: SessionTmuxFakes = { owner: null, running: new Set(), created: [] };
  const service = await sessionTmuxService(fakes, []);
  const context = {
    kind: "session-fork" as const,
    source: "claude" as const,
    sessionId: SESSION_ID,
    forkId: FORK_ID,
    title: FORK_TITLE,
  };

  const first = await service.open(context, { columns: 100, rows: 30 });
  const second = await service.open(context, { columns: 100, rows: 30 });

  expect(first.startedSession).toEqual({ sessionId: FORK_ID, title: FORK_TITLE });
  expect(second.startedSession).toBeUndefined();
  // And it joined rather than starting a second process for one fork.
  expect(fakes.created).toHaveLength(1);
});

test("says nothing was started when a terminal only resumes a session that exists", async () => {
  const fakes: SessionTmuxFakes = { owner: null, running: new Set(), created: [] };
  const service = await sessionTmuxService(fakes, []);

  const descriptor = await service.open(
    { kind: "session-tmux", source: "claude", sessionId: SESSION_ID },
    { columns: 100, rows: 30 },
  );

  expect(descriptor.startedSession).toBeUndefined();
});

test("puts the fork's transcript at the id its pane is named for", async () => {
  // `--session-id` is what makes the pane name and the transcript file the same uuid, so the fork
  // is findable rather than only startable.
  const fakes: SessionTmuxFakes = { owner: null, running: new Set(), created: [] };
  const service = await sessionTmuxService(fakes, []);

  await service.open(
    { kind: "session-fork", source: "claude", sessionId: SESSION_ID, forkId: FORK_ID, title: FORK_TITLE },
    { columns: 100, rows: 30 },
  );

  const command = fakes.created[0]!.command;
  expect(command[command.indexOf("--session-id") + 1]).toBe(FORK_ID);
});

test("gives two forks of one session two panes", async () => {
  const fakes: SessionTmuxFakes = { owner: null, running: new Set(), created: [] };
  const service = await sessionTmuxService(fakes, []);
  const second = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

  await service.open(
    { kind: "session-fork", source: "claude", sessionId: SESSION_ID, forkId: FORK_ID, title: FORK_TITLE },
    { columns: 100, rows: 30 },
  );
  await service.open(
    { kind: "session-fork", source: "claude", sessionId: SESSION_ID, forkId: second, title: "Source session (fork 3)" },
    { columns: 100, rows: 30 },
  );

  // Named for the fork, not its source: naming the pane after the session would put the second
  // fork in the first's terminal.
  expect(fakes.created.map((entry) => entry.session)).toEqual([
    `agentdesk-fork-${FORK_ID}`,
    `agentdesk-fork-${second}`,
  ]);
});

test("waits for a pane it just created to settle, and never for one it merely joins", async () => {
  // The whole point: `pipe-pane` starts at now, so attaching to a newborn pane pipes its startup
  // live and makes the viewer emulate every repaint. Waiting lets `capture-pane` collapse it, the
  // way tmux collapses it for its own clients.
  const created: SessionTmuxFakes = {
    owner: null, running: new Set(), created: [], settled: [],
  };
  await (await sessionTmuxService(created, [])).open(
    { kind: "session-fork", source: "claude", sessionId: SESSION_ID, forkId: FORK_ID, title: FORK_TITLE },
    { columns: 100, rows: 30 },
  );
  expect(created.settled).toEqual([`agentdesk-fork-${FORK_ID}`]);

  // A pane that already exists has already collapsed its startup into scrollback, so waiting on it
  // would spend seconds to gain nothing.
  const joined: SessionTmuxFakes = {
    owner: null, running: new Set([`agentdesk-${SESSION_ID}`]), created: [], settled: [],
  };
  await (await sessionTmuxService(joined, [])).open(
    { kind: "session-tmux", source: "claude", sessionId: SESSION_ID },
    { columns: 100, rows: 30 },
  );
  expect(joined.settled).toEqual([]);
});

const NEW_SESSION_ID = "3a1d7f22-90b4-4c6e-b3a5-8e2d0c9f4711";
const NEW_SESSION_TITLE = "AD 2";

test("starts a session that does not exist yet, in the directory it was handed", async () => {
  // Nothing to resolve: the catalog has never heard of this id and will not until the session's
  // first turn. That is the whole reason this kind exists -- a Bot whose directory has no sessions
  // can reach no other one.
  const fakes: SessionTmuxFakes = { owner: null, running: new Set(), created: [] };
  const attached: { session: string; columns: number; rows: number }[] = [];
  const { service, project } = await sessionTmuxFixture(fakes, attached);

  const descriptor = await service.open(
    {
      kind: "session-new",
      source: "claude",
      projectPath: project,
      sessionId: NEW_SESSION_ID,
      title: NEW_SESSION_TITLE,
    },
    { columns: 100, rows: 30 },
  );

  expect(fakes.created).toEqual([{
    // The pane the session's own `session-tmux` open will go looking for once it is real, which is
    // what keeps the card's terminal on one pane across that transition.
    session: `agentdesk-${NEW_SESSION_ID}`,
    // Resolved, not echoed: `realpath` is what makes the home check mean anything, and on macOS
    // it turns the fixture's `/tmp` root into `/private/tmp` on the way through.
    cwd: expect.stringContaining("projects/agent-desk"),
    // `--session-id` stands alone, without `--resume`: the transcript lands at an id the caller
    // already knows, which is the only way to recognise this session when it finally writes one.
    command: ["claude", "--session-id", NEW_SESSION_ID, "-n", NEW_SESSION_TITLE],
    columns: 100,
    rows: 30,
  }]);
  expect(attached).toEqual([{ session: `agentdesk-${NEW_SESSION_ID}`, columns: 100, rows: 30 }]);
  // The caller has nowhere else to read this from: there is no transcript to carry the name yet.
  expect(descriptor.startedSession).toEqual({
    sessionId: NEW_SESSION_ID,
    title: NEW_SESSION_TITLE,
  });
});

test("joins a started session's pane on a second open, and reports starting nothing", async () => {
  // Re-opening the card must not run a second `claude` in a second pane against one id. The
  // reported name would be wrong as well: `-n` was spent when the pane was created.
  const fakes: SessionTmuxFakes = {
    owner: null,
    running: new Set([`agentdesk-${NEW_SESSION_ID}`]),
    created: [],
  };
  const { service, project } = await sessionTmuxFixture(fakes, []);

  const descriptor = await service.open(
    {
      kind: "session-new",
      source: "claude",
      projectPath: project,
      sessionId: NEW_SESSION_ID,
      title: NEW_SESSION_TITLE,
    },
    { columns: 100, rows: 30 },
  );

  expect(fakes.created).toEqual([]);
  expect(descriptor.startedSession).toBeUndefined();
});

test("refuses to start a session outside the user home, or under a name it cannot pass on", async () => {
  const fakes: SessionTmuxFakes = { owner: null, running: new Set(), created: [] };
  const { service, project } = await sessionTmuxFixture(fakes, []);
  const start = (projectPath: string, title: string) => service.open(
    { kind: "session-new" as const, source: "claude" as const, projectPath, sessionId: NEW_SESSION_ID, title },
    { columns: 100, rows: 30 },
  );

  // The directory is the only thing standing between this kind and an arbitrary path on the
  // machine, because there is no session to check it against.
  await expect(start(tmpdir(), NEW_SESSION_TITLE)).rejects.toThrow(/inside the user home/);
  await expect(start("relative/path", NEW_SESSION_TITLE)).rejects.toThrow(/must be absolute/);
  await expect(start(join(project, "nowhere"), NEW_SESSION_TITLE)).rejects.toThrow(/does not exist/);
  // Naming one for the reader would start a session under a name they did not choose and cannot
  // see until it has taken a turn.
  await expect(start(project, "   ")).rejects.toThrow(/cannot be empty/);
  await expect(start(project, "two\nlines")).rejects.toThrow(/line break/);
  expect(fakes.created).toEqual([]);
});

test("refuses to start a codex session, which cannot be named or found before it speaks", async () => {
  const fakes: SessionTmuxFakes = { owner: null, running: new Set(), created: [] };
  const { service, project } = await sessionTmuxFixture(fakes, []);

  // `--session-id` and `-n` are Claude CLI flags. Codex has neither, so a Codex session started
  // here could not be recognised when its transcript appeared, nor addressed by other agents.
  await expect(service.open(
    {
      kind: "session-new",
      source: "codex" as "claude",
      projectPath: project,
      sessionId: NEW_SESSION_ID,
      title: NEW_SESSION_TITLE,
    },
    { columns: 100, rows: 30 },
  )).rejects.toThrow(/only claude sessions can be started/);
  expect(fakes.created).toEqual([]);
});

test("refuses to fork a codex session", async () => {
  const fakes: SessionTmuxFakes = { owner: null, running: new Set(), created: [] };
  const service = await sessionTmuxService(fakes, []);

  // `claude --resume <id> --fork-session` is a verified capability; codex has resume and no fork,
  // so this refuses rather than silently resuming the original.
  await expect(service.open(
    { kind: "session-fork", source: "codex" as "claude", sessionId: SESSION_ID, forkId: FORK_ID, title: FORK_TITLE },
    { columns: 100, rows: 30 },
  )).rejects.toThrow(/only claude sessions can be forked/);
  expect(fakes.created).toEqual([]);
});

test("attaches a session's own pane a second time instead of resuming it twice", async () => {
  const fakes: SessionTmuxFakes = {
    owner: null,
    running: new Set([`agentdesk-${SESSION_ID}`]),
    created: [],
  };
  const attached: { session: string; columns: number; rows: number }[] = [];
  const service = await sessionTmuxService(fakes, attached);

  const context = { kind: "session-tmux" as const, source: "claude" as const, sessionId: SESSION_ID };
  await service.open(context, { columns: 100, rows: 30 });
  await service.open(context, { columns: 80, rows: 24 });

  // The pane name is derived from the session id, so the second viewer lands on the first's pane.
  expect(fakes.created).toEqual([]);
  expect(attached).toEqual([
    { session: `agentdesk-${SESSION_ID}`, columns: 100, rows: 30 },
    { session: `agentdesk-${SESSION_ID}`, columns: 80, rows: 24 },
  ]);
});

test("prefers a human's pane over the one the sidecar resumed for the same session", async () => {
  // Three rows for one id is what the machine actually looks like once a session has been resumed
  // here: the resumed process registers under the id it resumed, beside the original.
  const rows = [
    { sessionId: SESSION_ID, tmuxSession: `agentdesk-${SESSION_ID}` },
    { sessionId: SESSION_ID, tmuxSession: null },
    { sessionId: SESSION_ID, tmuxSession: "agent-desk" },
    { sessionId: "another", tmuxSession: "elsewhere" },
  ];
  expect(await liveTmuxSession("claude", SESSION_ID, async () => rows)).toBe("agent-desk");

  // Ours when it is the only one, so a second viewer joins the first's pane.
  expect(await liveTmuxSession("claude", SESSION_ID, async () => [rows[0]!]))
    .toBe(`agentdesk-${SESSION_ID}`);
  expect(await liveTmuxSession("claude", SESSION_ID, async () => [rows[1]!])).toBe(null);
  // Codex publishes no registry, so it has nothing to look up and lands on the resume path.
  expect(await liveTmuxSession("codex", SESSION_ID, async () => rows)).toBe(null);
});
