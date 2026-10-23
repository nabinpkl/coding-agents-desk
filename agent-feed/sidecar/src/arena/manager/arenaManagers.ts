// A run's manager: started with the lanes, briefed while the run lives, ended with the run.
//
// The manager is an ordinary interactive session in a tmux pane, started the way a contestant's is
// (`startClaudeSession`, the opencode TUI on a serve session), in the run's `manager` folder. It acts
// on the run only through the arena's own HTTP API, which its brief spells out, and by its own
// harness's means it edits no file: Claude runs without its edit tools, and the opencode session is
// created holding rules that deny every edit. Its shell commands, each call to the API included,
// go through its harness's own permission mode, as the machine sets it (ADR-0138): asked of the
// reader, or put to Claude's auto-mode classifier. No allow rule is added for its run's routes: one
// would allow whatever else a curl line carries (a second URL, a file sent as the body), and the
// manager reads transcripts a contestant could have written to steer it. The arena never prompts it. What the arena does is
// keep its folder current: the brief, and every settled contestant's transcript and diff, rewritten
// whenever the run changes, so the reader can ask it to plan, prompt or compare the lanes at any
// point and the manager reads what is true now.
//
// The writes ride the registry's change signal rather than the service's own steps, so the service
// says only when a manager opens and when it goes; everything a contestant does that a manager should
// know about is a registry change already. They are queued one at a time per run, and each reads
// the run as it stands when its turn comes, so a burst of changes is one write, never two writes
// racing for one file.

import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { AgentSessionDescriptor, ArenaContestantSource } from "@agentdesk/agent-feed-wire";
import type { OpencodePermissionRule } from "@/agents/opencode/opencodeSessionCreate";
import type { ArenaContestantRecord, ArenaRunRecord, ArenaRunRegistry } from "@/arena/arenaRun";
import { claudeContestantArgv } from "@/arena/contestants/claudeContestant";
import { CLAUDE_EDIT_TOOLS } from "@/arena/contestants/laneStance";
import { LIVE_TERMINAL_STEPS } from "@/arena/contestants/terminalContestants";
import { briefFileName, renderManagerBrief, renderTranscriptFile } from "@/arena/manager/managerBrief";
import { claudeBinary } from "@/config/configBinaries";
import { claudeTranscriptPath } from "@/tasks/taskIdentity";
import { startClaudeSession } from "@/terminal/session-panes/claudeSessionLaunch";
import { killTmuxSession } from "@/terminal/tmux/tmuxSessions";
import { renderOpencodeHandover } from "@/transcripts/opencodeHandover";
import { renderHandover, type RenderedHandover } from "@/transcripts/sessionHandover";

/** The folder a run's manager works in, beside the contestants' worktrees. */
export const MANAGER_FOLDER = "manager";

/**
 * The rules an opencode manager's session holds, after its agent's: no edit of any file (the serve's
 * `edit` covers writing and patching too), and a shell command only once the reader allows it. The
 * serve's shell tool is `shell`, not `bash`: a rule under the old name is stored and never matches,
 * which a judge (the manager's first form) writing a file with `printf` showed.
 */
export const MANAGER_OPENCODE_RULES: readonly OpencodePermissionRule[] = [
  { action: "edit", resource: "*", effect: "deny" },
  { action: "shell", resource: "*", effect: "ask" },
];

/** What starting an opencode manager needs of the serve: a session created holding rules. */
export interface ManagerOpencodeBackend {
  createSession(
    requestId: string,
    projectPath: string,
    options: { permissions?: readonly OpencodePermissionRule[] },
  ): Promise<AgentSessionDescriptor>;
}

/** The acts a manager's life takes, injectable so its order can be tested without tmux or a harness. */
export interface ManagerSteps {
  /** Starts a Claude manager in a pane in `cwd` and answers the pane's name. */
  startClaude(options: { cwd: string; sessionId: string; title: string; command: string[] }): Promise<string>;
  /** Makes the opencode manager's session, holding the manager's rules, and answers its id. */
  openOpencode(requestId: string, cwd: string): Promise<string>;
  /** Starts the TUI on that session in a pane and answers the pane's name. */
  startOpencode(options: { cwd: string; sessionId: string; title: string }): Promise<string>;
  killPane(pane: string): Promise<void>;
  /** A settled contestant's session, rendered for reading; throws when there is nothing to render. */
  renderTranscript(source: ArenaContestantSource, sessionId: string): Promise<string>;
  /** A closed contestant's diff from the store, for a run reloaded with none in memory. */
  storedDiff(runId: string, contestantId: string): string | null;
}

/** The live steps, over this machine's tmux, CLIs and serve. */
export function liveManagerSteps(
  backend: ManagerOpencodeBackend,
  storedDiff: ManagerSteps["storedDiff"],
): ManagerSteps {
  return {
    startClaude: async (options) => (await startClaudeSession(options)).tmuxSession,
    openOpencode: async (requestId, cwd) =>
      (await backend.createSession(requestId, cwd, { permissions: MANAGER_OPENCODE_RULES })).sessionId,
    startOpencode: LIVE_TERMINAL_STEPS.startOpencode,
    killPane: killTmuxSession,
    renderTranscript: async (source, sessionId) => {
      if (source === "opencode") return handoverText(await renderOpencodeHandover(sessionId));
      const path = await claudeTranscriptPath(sessionId);
      if (!path) throw new Error(`no transcript for session ${sessionId}`);
      return handoverText(await renderHandover(sessionId, path));
    },
    storedDiff,
  };
}

function handoverText(rendered: RenderedHandover): string {
  return rendered.summary
    ? `Summary of the session before its latest compaction:\n\n${rendered.summary}\n\n---\n\n${rendered.turns}`
    : rendered.turns;
}

/** What one run's manager folder was last written from, and the queue its writes wait in. */
interface Written {
  nonce: string;
  brief: string | null;
  /** Each contestant's settled turn whose transcript and diff are in the folder, by id. */
  settled: Map<string, string>;
  queue: Promise<void>;
}

export class ArenaManagers {
  private readonly registry: ArenaRunRegistry;
  private readonly steps: ManagerSteps;
  private readonly claude: { binary?: string | null; model?: string | null; effort?: string | null };
  private readonly api: string;
  private readonly newSessionId: () => string;
  private readonly now: () => number;
  private readonly written = new Map<string, Written>();

  constructor(options: {
    registry: ArenaRunRegistry;
    steps: ManagerSteps;
    /** Overrides the binary lookup; null is "not installed", as the lookup answers it. */
    claude?: { binary?: string | null; model?: string | null; effort?: string | null };
    /** This sidecar's own address, which the brief tells the manager to call. */
    api: string;
    newSessionId?: () => string;
    now?: () => number;
  }) {
    this.api = options.api;
    this.registry = options.registry;
    this.steps = options.steps;
    this.claude = options.claude ?? {};
    this.newSessionId = options.newSessionId ?? randomUUID;
    this.now = options.now ?? Date.now;
    this.registry.onChange(() => {
      for (const run of this.registry.list()) {
        if (run.manager && run.manager.status !== "failed") void this.brief(run.runId);
      }
    });
  }

  /**
   * Picks the managers back up once, after a restart: a manager that was still starting is failed
   * with why, since what started it died with the old process; an open one's pane is tmux's and
   * still there, and its folder is written afresh.
   */
  resume(): void {
    for (const run of this.registry.list()) {
      if (run.manager?.status !== "starting") continue;
      this.registry.updateRun(run.runId, (one) => {
        one.manager = {
          ...one.manager!,
          status: "failed",
          error: "the sidecar restarted while the manager was starting",
        };
      });
    }
    for (const run of this.registry.list()) {
      if (run.manager?.status === "open") void this.brief(run.runId);
    }
  }

  /**
   * Starts a run's manager: its folder and brief first, so the harness finds its brief as it loads,
   * then its pane. A manager that cannot start fails on its own record; the run is not touched.
   */
  async open(runId: string): Promise<void> {
    const run = this.registry.get(runId);
    const manager = run?.manager;
    if (!run || !manager) throw new Error(`run "${runId}" has no manager to open`);
    const title = `arena manager ${runId.slice(0, 8)}`;
    try {
      await mkdir(manager.folder, { recursive: true });
      await this.brief(runId);
      let sessionId: string;
      let pane: string;
      if (manager.source === "claude") {
        const binary = this.claude.binary !== undefined ? this.claude.binary : claudeBinary();
        if (!binary) throw new Error("no claude CLI on this machine: install it, or set AGENT_FEED_CLAUDE_PATH");
        sessionId = this.newSessionId();
        // It changes the run through the API, never a file.
        const command = claudeContestantArgv({
          binary,
          sessionId,
          model: this.claude.model,
          effort: this.claude.effort,
          interactive: { name: title },
          without: CLAUDE_EDIT_TOOLS,
        });
        pane = await this.steps.startClaude({ cwd: manager.folder, sessionId, title, command });
      } else {
        sessionId = await this.steps.openOpencode(`${runId}:manager`, manager.folder);
        pane = await this.steps.startOpencode({ cwd: manager.folder, sessionId, title });
      }
      this.registry.updateRun(runId, (one) => {
        if (one.manager) one.manager = { ...one.manager, status: "open", sessionId, tmuxSession: pane };
      });
    } catch (error) {
      this.registry.updateRun(runId, (one) => {
        if (one.manager) {
          one.manager = {
            ...one.manager,
            status: "failed",
            error: error instanceof Error ? error.message : String(error),
          };
        }
      });
    }
  }

  /** Ends a run's manager: its pane, then its folder, once its last write has landed. */
  async close(run: ArenaRunRecord): Promise<void> {
    const manager = run.manager;
    if (!manager) return;
    if (manager.tmuxSession) {
      await this.steps.killPane(manager.tmuxSession).catch((error: unknown) => {
        console.error(`agent feed arena could not end the manager's pane ${manager.tmuxSession}`, error);
      });
    }
    await this.written.get(run.runId)?.queue;
    this.written.delete(run.runId);
    // Only the run's own manager folder is ever removed, so a corrupt record cannot point this anywhere else.
    if (dirname(manager.folder) !== run.folder || basename(manager.folder) !== MANAGER_FOLDER) {
      throw new Error(`${manager.folder} is not the manager folder of ${run.folder}`);
    }
    await rm(manager.folder, { recursive: true, force: true });
  }

  /** Queues a write of the run's manager folder; resolves once it has landed or failed. */
  private brief(runId: string): Promise<void> {
    let state = this.written.get(runId);
    if (!state) {
      state = { nonce: randomBytes(6).toString("hex"), brief: null, settled: new Map(), queue: Promise.resolve() };
      this.written.set(runId, state);
    }
    const written = state;
    written.queue = written.queue
      .then(() => this.write(runId, written))
      .catch((error: unknown) => {
        console.error(`agent feed arena could not brief the manager of run ${runId}`, error);
      });
    return written.queue;
  }

  /** Writes what changed since the last write: each newly settled contestant's files, then the brief. */
  private async write(runId: string, written: Written): Promise<void> {
    const run = this.registry.get(runId);
    if (!run?.manager || this.written.get(runId) !== written) return;
    const folder = run.manager.folder;
    const withDiffs: ArenaRunRecord = {
      ...run,
      contestants: run.contestants.map((one) => ({
        ...one,
        gitDiff: one.gitDiff ?? this.steps.storedDiff(runId, one.contestantId),
      })),
    };
    for (const contestant of withDiffs.contestants) {
      const turn = settledTurn(contestant);
      if (turn === null || written.settled.get(contestant.contestantId) === turn) continue;
      await this.writeContestant(folder, contestant, written.nonce);
      written.settled.set(contestant.contestantId, turn);
    }
    // Stamped with the time of writing, so it is compared without one.
    const key = JSON.stringify(
      renderManagerBrief(withDiffs, { nonce: written.nonce, now: 0, managerFolder: folder, api: this.api }),
    );
    if (key === written.brief) return;
    await mkdir(folder, { recursive: true });
    await writeWhole(
      join(folder, briefFileName(run.manager.source)),
      renderManagerBrief(withDiffs, { nonce: written.nonce, now: this.now(), managerFolder: folder, api: this.api }),
    );
    written.brief = key;
  }

  private async writeContestant(folder: string, contestant: ArenaContestantRecord, nonce: string): Promise<void> {
    let rendered: string | { problem: string };
    try {
      rendered = await this.steps.renderTranscript(contestant.source, contestant.sessionId!);
    } catch (error) {
      // Said in the file the manager would read, so a missing transcript is a fact it can report.
      rendered = { problem: error instanceof Error ? error.message : String(error) };
    }
    const transcript = renderTranscriptFile(contestant, rendered, nonce);
    await mkdir(folder, { recursive: true });
    await writeWhole(join(folder, `${contestant.contestantId}.md`), transcript);
    await writeWhole(join(folder, `${contestant.contestantId}.diff`), contestant.gitDiff ?? "");
  }
}

/** A stamp of a contestant's latest settled turn, or null while it has none to read. */
function settledTurn(contestant: ArenaContestantRecord): string | null {
  if (contestant.sessionId === null) return null;
  if (contestant.status !== "closed" && contestant.status !== "failed") return null;
  return `${contestant.status}:${contestant.closedAt}`;
}

/** Temp-then-rename, so the manager reading mid-write sees the last whole file, never half the next. */
async function writeWhole(path: string, text: string): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, text);
  await rename(temporary, path);
}
