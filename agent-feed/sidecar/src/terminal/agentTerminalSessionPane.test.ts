// Which pane an agent session is running in: the stamp, the registry, and what happens
// when tmux cannot be asked at all.

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

test("waits for a pane it just created to settle, and never for one it merely joins", async () => {
  // The whole point: `pipe-pane` starts at now, so attaching to a newborn pane pipes its startup
  // live and makes the viewer emulate every repaint. Waiting lets `capture-pane` collapse it, the
  // way tmux collapses it for its own clients.
  const created: SessionTmuxFakes = {
    owner: null, running: new Set(), created: [], settled: [],
  };
  await (await sessionTmuxService(created, [])).open(
    { kind: "session-tmux", source: "claude", sessionId: SESSION_ID },
    { columns: 100, rows: 30 },
  );
  expect(created.settled).toEqual([`agentdesk-${SESSION_ID}`]);

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
  // Passed explicitly so these stay unit tests: the default consults the REAL tmux on this
  // machine, which would make the answer depend on whatever happens to be running.
  const unstamped = async (): Promise<string | null> => null;
  const rows = [
    { sessionId: SESSION_ID, tmuxSession: `agentdesk-${SESSION_ID}` },
    { sessionId: SESSION_ID, tmuxSession: null },
    { sessionId: SESSION_ID, tmuxSession: "agent-desk" },
    { sessionId: "another", tmuxSession: "elsewhere" },
  ];
  expect(await liveTmuxSession("claude", SESSION_ID, async () => rows, unstamped))
    .toBe("agent-desk");

  // Ours when it is the only one, so a second viewer joins the first's pane.
  expect(await liveTmuxSession("claude", SESSION_ID, async () => [rows[0]!], unstamped))
    .toBe(`agentdesk-${SESSION_ID}`);
  expect(await liveTmuxSession("claude", SESSION_ID, async () => [rows[1]!], unstamped))
    .toBe(null);
  // Codex publishes no registry, so it has nothing to look up and lands on the resume path.
  expect(await liveTmuxSession("codex", SESSION_ID, async () => rows)).toBe(null);
});

// Which pane a session is running in, when its tmux has been renamed underneath the answer.

test("the stamp wins over the registry, which cached a name that no longer exists", async () => {
  // The registry row is written by the CLI, which resolved the name ONCE at startup and never
  // re-reads it. Measured: after a rename, `has-session` on that name exits 1 while the pane sits
  // there running. The stamp is set on the session itself and rides through the rename.
  const found = await liveTmuxSession(
    "claude",
    "b18b005e",
    async () => [{ sessionId: "b18b005e", tmuxSession: "agentdesk-b18b005e" }],
    async () => "terminal-tiles",
  );
  expect(found).toBe("terminal-tiles");
});

test("an unstamped pane still resolves through the registry", async () => {
  // Every pane started before the stamp existed, which is why the fallback stays.
  const found = await liveTmuxSession(
    "claude",
    "b18b005e",
    async () => [{ sessionId: "b18b005e", tmuxSession: "agentdesk-b18b005e" }],
    async () => null,
  );
  expect(found).toBe("agentdesk-b18b005e");
});

test("a tmux that cannot be asked falls back rather than failing the lookup", async () => {
  // No tmux on the machine is ordinary. A throwing stamp lookup must not take the registry answer
  // down with it, or a terminal that used to open stops opening.
  const found = await liveTmuxSession(
    "claude",
    "b18b005e",
    async () => [{ sessionId: "b18b005e", tmuxSession: "agentdesk-b18b005e" }],
    async () => {
      throw new Error("no tmux");
    },
  );
  expect(found).toBe("agentdesk-b18b005e");
});

const OPENCODE_SESSION_ID = "ses_abc123XYZ";

test("an opencode session starts a pane running the TUI in its own directory", async () => {
  const fakes: SessionTmuxFakes = { owner: null, running: new Set(), created: [] };
  const attached: { session: string; columns: number; rows: number }[] = [];
  const service = await sessionTmuxService(fakes, attached);

  const descriptor = await service.open(
    { kind: "session-tmux", source: "opencode", sessionId: OPENCODE_SESSION_ID },
    { columns: 100, rows: 30 },
  );

  // No harness CLI to resume under -- the serve owns the session -- so the pane runs the TUI
  // itself where the reader picks the session up. A second open joins this pane by name.
  expect(fakes.created).toEqual([{
    session: `agentdesk-opencode-${OPENCODE_SESSION_ID}`,
    cwd: expect.stringContaining("projects/agent-desk"),
    command: ["opencode"],
    columns: 100,
    rows: 30,
  }]);
  expect(attached).toEqual([{ session: `agentdesk-opencode-${OPENCODE_SESSION_ID}`, columns: 100, rows: 30 }]);
  expect(descriptor.ptySessionName).toBe(`agent-tmux-agentdesk-opencode-${OPENCODE_SESSION_ID}`);
});

test("an opencode session joins the pane its stamp names instead of starting a second", async () => {
  const fakes: SessionTmuxFakes = { owner: "opencode-title-pane", running: new Set(), created: [] };
  const attached: { session: string; columns: number; rows: number }[] = [];
  const service = await sessionTmuxService(fakes, attached);

  await service.open(
    { kind: "session-tmux", source: "opencode", sessionId: OPENCODE_SESSION_ID },
    { columns: 100, rows: 30 },
  );

  expect(fakes.created).toEqual([]);
  expect(attached).toEqual([{ session: "opencode-title-pane", columns: 100, rows: 30 }]);
});

test("an opencode session id that is not a serve id is refused before touching tmux", async () => {
  const fakes: SessionTmuxFakes = { owner: null, running: new Set(), created: [] };
  const attached: { session: string; columns: number; rows: number }[] = [];
  const service = await sessionTmuxService(fakes, attached);

  await expect(service.open(
    { kind: "session-tmux", source: "opencode", sessionId: "019c3708-fadb-7e2f-a744-322df224faf4" },
    { columns: 100, rows: 30 },
  )).rejects.toBeInstanceOf(AgentTerminalInvalidError);
  expect(fakes.created).toEqual([]);
  expect(attached).toEqual([]);
});

test("liveTmuxSession answers an opencode session from its stamp alone", async () => {
  // No process registry for the serve's sessions: the stamp on the pane is the whole lookup.
  expect(await liveTmuxSession("opencode", OPENCODE_SESSION_ID, async () => [], async () => "opencode-title-pane"))
    .toBe("opencode-title-pane");
  expect(await liveTmuxSession("opencode", OPENCODE_SESSION_ID, async () => [], async () => null))
    .toBeNull();
});
