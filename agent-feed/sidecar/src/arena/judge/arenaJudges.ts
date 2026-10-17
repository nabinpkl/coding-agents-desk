// A run's judge: started with the lanes, briefed while the run lives, ended with the run.
//
// The judge is an ordinary interactive session in a tmux pane, started the way a contestant's is
// (`startClaudeSession`, the opencode TUI on a serve session), in the run's `judge` folder. It is
// read-only by its own harness's means: Claude runs in its plan mode, and the opencode session is
// created holding rules that deny every edit and ask before a shell command. The arena never
// prompts it. What the arena does is keep its folder current: the brief, and every settled
// contestant's transcript and diff, rewritten whenever the run changes, so the reader can ask for a
// verdict at any point and the judge reads what is true now.
//
// The writes ride the registry's change signal rather than the service's own steps, so the service
// says only when a judge opens and when it goes; everything a contestant does that a judge should
// know about is a registry change already. They are queued one at a time per run, and each reads
// the run as it stands when its turn comes, so a burst of changes is one write, never two writes
// racing for one file.

import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { AgentSessionDescriptor, ArenaContestantSource } from "@agentdesk/agent-feed-wire";
import type { OpencodePermissionRule } from "@/agents/opencode/opencodeAgentBackend";
import type { ArenaContestantRecord, ArenaRunRecord, ArenaRunRegistry } from "@/arena/arenaRun";
import { claudeContestantArgv } from "@/arena/contestants/claudeContestant";
import { LIVE_TERMINAL_STEPS } from "@/arena/contestants/terminalContestants";
import { briefFileName, renderJudgeBrief, renderTranscriptFile } from "@/arena/judge/judgeBrief";
import { claudeBinary } from "@/config/configBinaries";
import { claudeTranscriptPath } from "@/tasks/taskIdentity";
import { startClaudeSession } from "@/terminal/claudeSessionLaunch";
import { killTmuxSession } from "@/terminal/tmux/tmuxSessions";
import { renderOpencodeHandover } from "@/transcripts/opencodeHandover";
import { renderHandover, type RenderedHandover } from "@/transcripts/sessionHandover";

/** The folder a run's judge works in, beside the contestants' worktrees. */
export const JUDGE_FOLDER = "judge";

/**
 * The rules an opencode judge's session holds, after its agent's: no edit of any file (the serve's
 * `edit` covers writing and patching too), and a shell command only once the reader allows it. The
 * serve's shell tool is `shell`, not `bash`: a rule under the old name is stored and never matches,
 * which a judge writing a file with `printf` showed.
 */
export const JUDGE_OPENCODE_RULES: readonly OpencodePermissionRule[] = [
  { action: "edit", resource: "*", effect: "deny" },
  { action: "shell", resource: "*", effect: "ask" },
];

/** What starting an opencode judge needs of the serve: a session created holding rules. */
export interface JudgeOpencodeBackend {
  createSession(
    requestId: string,
    projectPath: string,
    options: { permissions?: readonly OpencodePermissionRule[] },
  ): Promise<AgentSessionDescriptor>;
}

/** The acts a judge's life takes, injectable so its order can be tested without tmux or a harness. */
export interface JudgeSteps {
  /** Starts a Claude judge in a pane in `cwd` and answers the pane's name. */
  startClaude(options: { cwd: string; sessionId: string; title: string; command: string[] }): Promise<string>;
  /** Makes the opencode judge's session, holding the judge's rules, and answers its id. */
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
export function liveJudgeSteps(backend: JudgeOpencodeBackend, storedDiff: JudgeSteps["storedDiff"]): JudgeSteps {
  return {
    startClaude: async (options) => (await startClaudeSession(options)).tmuxSession,
    openOpencode: async (requestId, cwd) =>
      (await backend.createSession(requestId, cwd, { permissions: JUDGE_OPENCODE_RULES })).sessionId,
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

/** What one run's judge folder was last written from, and the queue its writes wait in. */
interface Written {
  nonce: string;
  brief: string | null;
  /** Each contestant's settled turn whose transcript and diff are in the folder, by id. */
  settled: Map<string, string>;
  queue: Promise<void>;
}

export class ArenaJudges {
  private readonly registry: ArenaRunRegistry;
  private readonly steps: JudgeSteps;
  private readonly claude: { binary?: string | null; model?: string | null; effort?: string | null };
  private readonly newSessionId: () => string;
  private readonly now: () => number;
  private readonly written = new Map<string, Written>();

  constructor(options: {
    registry: ArenaRunRegistry;
    steps: JudgeSteps;
    /** Overrides the binary lookup; null is "not installed", as the lookup answers it. */
    claude?: { binary?: string | null; model?: string | null; effort?: string | null };
    newSessionId?: () => string;
    now?: () => number;
  }) {
    this.registry = options.registry;
    this.steps = options.steps;
    this.claude = options.claude ?? {};
    this.newSessionId = options.newSessionId ?? randomUUID;
    this.now = options.now ?? Date.now;
    this.registry.onChange(() => {
      for (const run of this.registry.list()) {
        if (run.judge && run.judge.status !== "failed") void this.brief(run.runId);
      }
    });
  }

  /**
   * Picks the judges back up once, after a restart: a judge that was still starting is failed
   * with why, since what started it died with the old process; an open one's pane is tmux's and
   * still there, and its folder is written afresh.
   */
  resume(): void {
    for (const run of this.registry.list()) {
      if (run.judge?.status !== "starting") continue;
      this.registry.updateRun(run.runId, (one) => {
        one.judge = { ...one.judge!, status: "failed", error: "the sidecar restarted while the judge was starting" };
      });
    }
    for (const run of this.registry.list()) {
      if (run.judge?.status === "open") void this.brief(run.runId);
    }
  }

  /**
   * Starts a run's judge: its folder and brief first, so the harness finds its brief as it loads,
   * then its pane. A judge that cannot start fails on its own record; the run is not touched.
   */
  async open(runId: string): Promise<void> {
    const run = this.registry.get(runId);
    const judge = run?.judge;
    if (!run || !judge) throw new Error(`run "${runId}" has no judge to open`);
    const title = `arena judge ${runId.slice(0, 8)}`;
    try {
      await mkdir(judge.folder, { recursive: true });
      await this.brief(runId);
      let sessionId: string;
      let pane: string;
      if (judge.source === "claude") {
        const binary = this.claude.binary !== undefined ? this.claude.binary : claudeBinary();
        if (!binary) throw new Error("no claude CLI on this machine: install it, or set AGENT_FEED_CLAUDE_PATH");
        sessionId = this.newSessionId();
        const command = [
          ...claudeContestantArgv({
            binary,
            sessionId,
            model: this.claude.model,
            effort: this.claude.effort,
            interactive: { name: title },
          }),
          "--permission-mode",
          "plan",
        ];
        pane = await this.steps.startClaude({ cwd: judge.folder, sessionId, title, command });
      } else {
        sessionId = await this.steps.openOpencode(`${runId}:judge`, judge.folder);
        pane = await this.steps.startOpencode({ cwd: judge.folder, sessionId, title });
      }
      this.registry.updateRun(runId, (one) => {
        if (one.judge) one.judge = { ...one.judge, status: "open", sessionId, tmuxSession: pane };
      });
    } catch (error) {
      this.registry.updateRun(runId, (one) => {
        if (one.judge) {
          one.judge = { ...one.judge, status: "failed", error: error instanceof Error ? error.message : String(error) };
        }
      });
    }
  }

  /** Ends a run's judge: its pane, then its folder, once its last write has landed. */
  async close(run: ArenaRunRecord): Promise<void> {
    const judge = run.judge;
    if (!judge) return;
    if (judge.tmuxSession) {
      await this.steps.killPane(judge.tmuxSession).catch((error: unknown) => {
        console.error(`agent feed arena could not end the judge's pane ${judge.tmuxSession}`, error);
      });
    }
    await this.written.get(run.runId)?.queue;
    this.written.delete(run.runId);
    // Only the run's own judge folder is ever removed, so a corrupt record cannot point this anywhere else.
    if (dirname(judge.folder) !== run.folder || basename(judge.folder) !== JUDGE_FOLDER) {
      throw new Error(`${judge.folder} is not the judge folder of ${run.folder}`);
    }
    await rm(judge.folder, { recursive: true, force: true });
  }

  /** Queues a write of the run's judge folder; resolves once it has landed or failed. */
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
        console.error(`agent feed arena could not brief the judge of run ${runId}`, error);
      });
    return written.queue;
  }

  /** Writes what changed since the last write: each newly settled contestant's files, then the brief. */
  private async write(runId: string, written: Written): Promise<void> {
    const run = this.registry.get(runId);
    if (!run?.judge || this.written.get(runId) !== written) return;
    const folder = run.judge.folder;
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
    const key = JSON.stringify(renderJudgeBrief(withDiffs, { nonce: written.nonce, now: 0, judgeFolder: folder }));
    if (key === written.brief) return;
    await mkdir(folder, { recursive: true });
    await writeWhole(
      join(folder, briefFileName(run.judge.source)),
      renderJudgeBrief(withDiffs, { nonce: written.nonce, now: this.now(), judgeFolder: folder }),
    );
    written.brief = key;
  }

  private async writeContestant(folder: string, contestant: ArenaContestantRecord, nonce: string): Promise<void> {
    let rendered: string | { problem: string };
    try {
      rendered = await this.steps.renderTranscript(contestant.source, contestant.sessionId!);
    } catch (error) {
      // Said in the file the judge would read, so a missing transcript is a fact it can report.
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

/** Temp-then-rename, so the judge reading mid-write sees the last whole file, never half the next. */
async function writeWhole(path: string, text: string): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, text);
  await rename(temporary, path);
}
