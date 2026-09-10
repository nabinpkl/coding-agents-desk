// The fakes an AgentTerminalService test runs against: a recording PTY client, a recording
// tmux attachment, and the two ways a session resolves to a pane.
//
// A function rather than module state, so each file gets its own temporary roots and its
// own cleanup. Call it once at the top of a file.

import { afterEach } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentTerminalService,
  liveTmuxSession,
  type AgentTerminalPtyClient,
} from "@/terminal/agentTerminalService";
import type { PtySessionConnection } from "@/terminal/pty/ptyClient";
import type { TmuxAttachments, TmuxSessionConnection } from "@/terminal/tmux/tmuxAttachment";

export const SESSION_ID = "019c3708-fadb-7e2f-a744-322df224faf4";

export interface SessionTmuxFakes {
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

export function agentTerminalHarness() {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
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

  return { roots, serviceWithTmux, sessionTmuxFixture, sessionTmuxService, tmuxConnection };
}
