// One arena run's life: validate the request, make the worktrees, fan the prompt out to every
// contestant at once, and record what each did.
//
// The service is the only writer of runs: routes talk to it, and it talks to the worktrees, the
// drivers, the registry and the store, so a run's state has one owner while it lives.
// Contestants are driven in the background and never block the request that started them --
// a run that waited for its slowest contestant would answer the panel a minute late with
// nothing to show but the wait. Their failures land on the contestant's record, not the run's:
// one contestant failing is a fact about that contestant, and the run is the grouping.
//
// Each contestant names the harness that drives it, and the drivers arrive wired: a source
// with no driver is refused with a 400 naming it, so one run can duel two of the same harness
// or one of each, and a harness this build cannot drive never starts a worktree.
//
// A run is driven in one of two modes, each with its own set of drivers. Headless drives each
// harness with no pane; terminals starts each contestant as an ordinary session in a tmux pane
// and holds them all at one start line until every one can take the prompt. The terminals
// drivers are wired only where tmux is, so a machine without it offers headless alone.

import { randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";
import type {
  ArenaContestantSource,
  ArenaCreateRunRequest,
  ArenaNewRunDefaults,
  ArenaRunDetail,
  ArenaRunMode,
  ArenaRunSummary,
} from "@agentdesk/agent-feed-wire";
import {
  ArenaRunRegistry,
  isLiveContestant,
  runDetail,
  runSummary,
  type ArenaContestantRecord,
  type ArenaRunRecord,
} from "@/arena/arenaRun";
import { claimRunFolder, nextRunName, releaseRunFolder, runNameFor } from "@/arena/arenaRunFolders";
import { ArenaStore } from "@/arena/arenaStore";
import {
  addContestantWorktree,
  assertGitRepository,
  captureWorktreeDiff,
  initRunRepository,
  pruneWorktrees,
  removeContestantWorktree,
} from "@/arena/arenaWorktrees";
import {
  StartLine,
  type ContestantDriver,
  type ContestantDrivers,
  type ContestantPlan,
  type ContestantTerminal,
} from "@/arena/contestantDriver";
import { killTmuxSession } from "@/terminal/tmux/tmuxSessions";
import { filesFromEvents } from "@/arena/arenaFacts";

/** The request could not become a run; the route answers it with a 400 naming this reason. */
export class ArenaBadRequestError extends Error {}
/** The run id names no run; the route answers with a 404. */
export class ArenaRunNotFoundError extends Error {}
/** The run is still dueling and cannot be torn down; the route answers with a 409. */
export class ArenaRunBusyError extends Error {}

/** A diff longer than this is truncated with a marker, in memory and in its file alike. */
const MAXIMUM_DIFF_BYTES = 256 * 1024;

/** How long one contestant's turn may run before the service gives up on it. */
const TURN_TIMEOUT_MS = 10 * 60 * 1000;

/** The most contestants one run may fan out to; past this a run stops being watchable. */
const MAXIMUM_CONTESTANTS = 8;

/** The worktree steps, as the service needs them; injected so its tests can fake git. */
export interface ArenaWorktreeSteps {
  assertRepository(repoPath: string): Promise<void>;
  initRepository(options: { path: string; message: string; worktreeFolders: readonly string[] }): Promise<void>;
  add(options: { repoPath: string; path: string; ref: string }): Promise<void>;
  remove(options: { repoPath: string; path: string }): Promise<void>;
  prune(repoPath: string): Promise<void>;
  captureDiff(options: { worktreePath: string; ref: string }): Promise<string>;
}

export class ArenaService {
  private readonly registry: ArenaRunRegistry;
  private readonly store: ArenaStore;
  private readonly drivers: ContestantDrivers;
  private readonly terminalDrivers: ContestantDrivers | null;
  private readonly killPane: (pane: string) => Promise<void>;
  private readonly worktrees: ArenaWorktreeSteps;
  private readonly arenaHome: string;
  private readonly turnTimeoutMs: number;
  private readonly newRunId: () => string;
  /** Each live terminals run's start line, and the drives that wait at it, by run id. */
  private readonly lines = new Map<string, StartLine>();
  private readonly drives = new Map<string, Promise<void>[]>();

  constructor(options: {
    registry: ArenaRunRegistry;
    store: ArenaStore;
    /** One headless driver per source this sidecar can duel; the wiring is `arenaWiring.ts`. */
    drivers: ContestantDrivers;
    /** The terminals mode's drivers, or null where this machine has no tmux to run them in. */
    terminalDrivers?: ContestantDrivers | null;
    /** Ends a contestant's pane when its run is deleted; tmux's own kill unless a test says. */
    killPane?: (pane: string) => Promise<void>;
    /** Overridden in tests; the real steps are this module's own `arenaWorktrees.ts`. */
    worktrees?: ArenaWorktreeSteps;
    /** Where each run's folder is made; absolute. */
    arenaHome: string;
    turnTimeoutMs?: number;
    newRunId?: () => string;
  }) {
    this.registry = options.registry;
    this.store = options.store;
    this.drivers = options.drivers;
    this.terminalDrivers = options.terminalDrivers ?? null;
    this.killPane = options.killPane ?? killTmuxSession;
    this.worktrees = options.worktrees ?? {
      assertRepository: assertGitRepository,
      initRepository: initRunRepository,
      add: addContestantWorktree,
      remove: removeContestantWorktree,
      prune: pruneWorktrees,
      captureDiff: captureWorktreeDiff,
    };
    if (!isAbsolute(options.arenaHome)) throw new Error(`the arena home must be absolute: "${options.arenaHome}"`);
    this.arenaHome = options.arenaHome;
    this.turnTimeoutMs = options.turnTimeoutMs ?? TURN_TIMEOUT_MS;
    this.newRunId = options.newRunId ?? randomUUID;
    // One persistence owner: every registry change saves the whole index, so a sidecar that
    // dies mid-run leaves on disk every run whose contestants had already closed.
    this.registry.onChange(() => this.store.save(this.registry.list()));
  }

  onRunsChanged(listener: () => void): () => void {
    return this.registry.onChange(listener);
  }

  /** The modes this machine can run, the default first. */
  modes(): ArenaRunMode[] {
    return this.terminalDrivers ? ["terminals", "headless"] : ["headless"];
  }

  /** What a run asked for with nothing filled in would get here, right now. */
  newRunDefaults(): ArenaNewRunDefaults {
    const nextName = nextRunName(this.arenaHome, this.registry.list().map((run) => run.name));
    return { modes: this.modes(), arenaHome: this.arenaHome, nextName };
  }

  listRuns(): ArenaRunSummary[] {
    return this.registry.list().map(runSummary);
  }

  runDetailFor(runId: string): ArenaRunDetail | null {
    const run = this.registry.get(runId);
    if (!run) return null;
    return runDetail(run, (contestant) => this.store.readContestantDiff(runId, contestant.contestantId));
  }

  /**
   * Validates the request, makes the run's folder (and, when it names no repository, the run's
   * own repository there), makes every contestant's worktree in it, registers the run, and fans
   * the prompt out in the background. The answer is the run as it stands at the moment of asking:
   * every contestant preparing, none yet running.
   */
  async createRun(request: ArenaCreateRunRequest): Promise<ArenaRunSummary> {
    const prompt = typeof request.prompt === "string" ? request.prompt.trim() : "";
    checkPromptLength(prompt);

    const naming = runNameFor(request.name, this.arenaHome, this.registry.list().map((run) => run.name));
    if ("problem" in naming) throw new ArenaBadRequestError(naming.problem);
    const { name, folderName } = naming;

    // No repository named means the run gets one of its own, made in its folder below.
    const namedRepo = typeof request.repoPath === "string" ? request.repoPath.trim() : "";
    if (namedRepo) {
      if (!isAbsolute(namedRepo)) throw new ArenaBadRequestError(`repoPath must be absolute: "${namedRepo}"`);
      await this.worktrees.assertRepository(namedRepo);
    }

    const baseRef = typeof request.baseRef === "string" && request.baseRef.trim()
      ? request.baseRef.trim()
      : "HEAD";

    const mode: ArenaRunMode = request.mode ?? this.modes()[0]!;
    if (mode !== "terminals" && mode !== "headless") {
      throw new ArenaBadRequestError(`mode must be "terminals" or "headless", not "${String(mode)}"`);
    }
    const drivers = mode === "terminals" ? this.terminalDrivers : this.drivers;
    if (!drivers) {
      throw new ArenaBadRequestError("this machine has no tmux, so a run here can only be headless");
    }
    // A terminals run may open its lanes first and take its prompt once they are up; a headless
    // run has nothing to open, so its prompt is the run.
    if (!prompt && mode === "headless") throw new ArenaBadRequestError("a run needs a prompt");

    if (!Array.isArray(request.contestants) || request.contestants.length === 0) {
      throw new ArenaBadRequestError("a run needs at least one contestant");
    }
    if (request.contestants.length > MAXIMUM_CONTESTANTS) {
      throw new ArenaBadRequestError(`a run fans out to at most ${MAXIMUM_CONTESTANTS} contestants`);
    }
    for (const [index, contestant] of request.contestants.entries()) {
      if (!contestant || !drivers[contestant.source as ArenaContestantSource]) {
        throw new ArenaBadRequestError(
          `contestant ${index} names source "${contestant?.source ?? "none"}", which this arena cannot drive`,
        );
      }
    }

    const runId = this.newRunId();
    if (!/^[0-9a-f-]{36}$/.test(runId)) {
      throw new ArenaBadRequestError("a run id must be a uuid");
    }

    // The folder last of all the checks, so a refused request leaves nothing in the home.
    const folder = claimRunFolder(this.arenaHome, folderName);
    if (!folder) {
      throw new ArenaBadRequestError(
        `${join(this.arenaHome, folderName)} already exists; name this run something else`,
      );
    }
    const repoCreated = !namedRepo;
    const repoPath = namedRepo || folder;

    const records: ArenaContestantRecord[] = request.contestants.map((contestant, index) => ({
      contestantId: `c${index + 1}`,
      source: contestant.source,
      sessionId: null,
      worktreePath: join(folder, `c${index + 1}`),
      tmuxSession: null,
      status: "preparing" as const,
      startedAt: null,
      closedAt: null,
      error: null,
      contextTokens: null,
      costUsd: null,
      filesRead: [],
      filesWritten: [],
      gitDiff: null,
    }));

    // Every worktree before the run is registered, so a run that reaches the registry is whole:
    // a contestant cannot be handed a prompt for a directory that was never made. A failure
    // halfway undoes the worktrees already made and the folder, and leaves no run behind.
    try {
      if (repoCreated) {
        await this.worktrees.initRepository({
          path: folder,
          message: name,
          worktreeFolders: records.map((record) => record.contestantId),
        });
      }
      for (const record of records) {
        await this.worktrees.add({ repoPath, path: record.worktreePath, ref: baseRef });
      }
    } catch (error) {
      await this.undoWorktrees(repoPath, records).catch(() => undefined);
      this.releaseFolder(folder, repoCreated);
      throw error;
    }

    const run: ArenaRunRecord = {
      runId,
      name,
      folder,
      prompt,
      repoPath,
      repoCreated,
      baseRef,
      mode,
      createdAt: Date.now(),
      contestants: records,
    };
    this.registry.add(run);

    // Fanned out, not awaited: the run is live the moment it is registered, and each contestant
    // closes on its own. `void` with the failure handled inside, so a contestant that fails
    // records its failure rather than surfacing as an unhandled rejection.
    const startLine = mode === "terminals" ? new StartLine(records.length, prompt || null) : null;
    if (startLine) this.lines.set(runId, startLine);
    this.drives.set(runId, records.map((record) => this.driveOne(run, record, drivers, startLine)));
    return runSummary(run);
  }

  /**
   * Gives a terminals run whose lanes are open the prompt they are waiting for. It goes into every
   * lane together once all of them are ready, which may already be the case.
   */
  sendPrompt(runId: string, raw: unknown): ArenaRunSummary {
    const run = this.registry.get(runId);
    if (!run) throw new ArenaRunNotFoundError(`no arena run "${runId}"`);
    const prompt = typeof raw === "string" ? raw.trim() : "";
    if (!prompt) throw new ArenaBadRequestError("a prompt cannot be empty");
    checkPromptLength(prompt);
    const line = this.lines.get(runId);
    if (run.prompt || line?.prompted) throw new ArenaBadRequestError("this run already has its prompt");
    if (!line) throw new ArenaBadRequestError("this run's lanes are no longer open to take a prompt");
    this.registry.updateRun(runId, (one) => {
      one.prompt = prompt;
    });
    line.give(prompt);
    return runSummary(run);
  }

  /**
   * Tears a finished run down: panes ended, worktrees back to the repository, registrations
   * pruned, the run's folder removed (its own repository with it, when the arena made one), its
   * diffs under the arena root deleted, the record dropped. A run with a
   * contestant still live is refused -- its worktree holds a contestant whose work this would
   * delete underneath it.
   *
   * The panes go first and go here, not when a turn closes: a closed contestant's pane is still a
   * session the reader may be reading or typing into, and its process runs inside the worktree
   * that is removed next.
   */
  async deleteRun(runId: string): Promise<void> {
    const run = this.registry.get(runId);
    if (!run) throw new ArenaRunNotFoundError(`no arena run "${runId}"`);
    const line = this.lines.get(runId);
    // Lanes open and still waiting for their prompt hold nothing the reader asked for yet, so
    // removing the run is closing them: the line refuses whoever waits at it, the panes are ended
    // under whoever is still on the way up, and the removal waits for every drive to have failed.
    const unprompted = line !== undefined && !line.prompted;
    if (run.contestants.some(isLiveContestant) && !unprompted) {
      throw new ArenaRunBusyError(`run "${runId}" still has a contestant dueling`);
    }
    if (unprompted) line.abort(new Error("the run was removed before it was given a prompt"));
    for (const contestant of run.contestants) {
      if (!contestant.tmuxSession) continue;
      await this.killPane(contestant.tmuxSession).catch((error: unknown) => {
        console.error(`agent feed arena could not end pane ${contestant.tmuxSession}`, error);
      });
    }
    await Promise.allSettled(this.drives.get(runId) ?? []);
    this.lines.delete(runId);
    this.drives.delete(runId);
    await this.undoWorktrees(run.repoPath, run.contestants);
    this.releaseFolder(run.folder, run.repoCreated);
    this.store.deleteRunDirectory(runId);
    this.registry.remove(runId);
  }

  /** Removes a run's folder, best-effort like its worktrees: a refusal is named in the log. */
  private releaseFolder(folder: string, repoCreated: boolean): void {
    try {
      releaseRunFolder(this.arenaHome, folder, repoCreated);
    } catch (error) {
      console.error(`agent feed arena left the run folder ${folder}`, error);
    }
  }

  /**
   * Removes every contestant's worktree and prunes the registrations, best-effort and whole.
   *
   * Every removal is attempted even after one fails, then every failure is named in the log: a
   * teardown that stopped at the first refusal would leave the rest of a run's worktrees
   * registered against the repository, which is the half-torn-down state
   * `worktreeRemovalRefusal` refuses to let a caller reach. A worktree that was never made --
   * the failure this is called from -- is refused by the same check as a stranger's, and the
   * rest still go.
   */
  private async undoWorktrees(
    repoPath: string,
    records: readonly Pick<ArenaContestantRecord, "worktreePath">[],
  ): Promise<void> {
    const refused: string[] = [];
    for (const record of records) {
      try {
        await this.worktrees.remove({ repoPath, path: record.worktreePath });
      } catch (error) {
        refused.push(`${record.worktreePath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    await this.worktrees.prune(repoPath);
    if (refused.length > 0) {
      console.error(
        `agent feed arena left worktrees in ${repoPath} (${refused.length}): ${refused.join("; ")}`,
      );
    }
  }

  /**
   * One contestant's whole turn: send the prompt, wait for the close, record the facts.
   *
   * Every state it passes through is written to the record as it happens, so a run is watchable
   * from its first moment and a contestant that dies mid-turn leaves its failure where the
   * reader is already looking.
   */
  private async driveOne(
    run: ArenaRunRecord,
    record: ArenaContestantRecord,
    drivers: ContestantDrivers,
    startLine: StartLine | null,
  ): Promise<void> {
    const mark = (apply: (contestant: ArenaContestantRecord, now: number) => void): void => {
      this.registry.updateContestant(run.runId, record.contestantId, apply);
    };
    let arrived = false;
    const terminal: ContestantTerminal | undefined = startLine
      ? {
        label: `arena ${record.contestantId} ${run.runId.slice(0, 8)}`,
        onPane: (pane, sessionId) => {
          mark((contestant) => {
            contestant.tmuxSession = pane;
            contestant.sessionId = sessionId;
            contestant.status = "starting";
          });
        },
        ready: async () => {
          mark((contestant) => {
            contestant.status = "ready";
          });
          arrived = true;
          const prompt = await startLine.arrive();
          // The clock starts at the prompt, not at the pane: a harness's load time, and a reader
          // answering its startup question, are not part of the turn being compared.
          mark((contestant, now) => {
            contestant.status = "running";
            contestant.startedAt = now;
          });
          return prompt;
        },
      }
      : undefined;
    try {
      const drive: ContestantDriver | undefined = drivers[record.source];
      // createRun refused every source without a driver, so this is a broken invariant.
      if (!drive) throw new Error(`no driver wired for source "${record.source}"`);
      const plan: ContestantPlan = {
        prompt: run.prompt,
        worktreePath: record.worktreePath,
        requestId: `${run.runId}:${record.contestantId}`,
        turnTimeoutMs: this.turnTimeoutMs,
        ...(terminal ? { terminal } : {}),
        onSessionId: (sessionId) => {
          mark((contestant, now) => {
            // The session exists from here, so a reader can open it while it duels; the turn
            // has not run yet, which is why the status says running rather than closed.
            contestant.sessionId = sessionId;
            contestant.startedAt = now;
            contestant.status = "running";
          });
        },
      };
      const result = await drive(plan);

      const { filesRead, filesWritten } = filesFromEvents(result.events);
      const diff = await this.worktrees.captureDiff({
        worktreePath: record.worktreePath,
        ref: run.baseRef,
      });
      const bounded = diff.length > MAXIMUM_DIFF_BYTES
        ? `${diff.slice(0, MAXIMUM_DIFF_BYTES)}\n… truncated at ${MAXIMUM_DIFF_BYTES} bytes\n`
        : diff;
      this.store.writeContestantDiff(run.runId, record.contestantId, bounded);
      this.registry.updateContestant(run.runId, record.contestantId, (contestant, now) => {
        contestant.status = "closed";
        contestant.closedAt = now;
        contestant.contextTokens = result.usage?.current ?? null;
        contestant.costUsd = result.usage?.cost ?? null;
        contestant.filesRead = filesRead;
        contestant.filesWritten = filesWritten;
        contestant.gitDiff = bounded;
      });
    } catch (error) {
      this.registry.updateContestant(run.runId, record.contestantId, (contestant, now) => {
        contestant.status = "failed";
        contestant.closedAt = now;
        contestant.error = error instanceof Error ? error.message : String(error);
      });
    } finally {
      // A contestant that never reached the start line is out of the race, so nobody waits on it.
      if (startLine && !arrived) startLine.leave();
    }
  }
}

/** A prompt past this is refused rather than typed into a dozen panes. */
function checkPromptLength(prompt: string): void {
  if (prompt.length > 16_000) throw new ArenaBadRequestError("a run's prompt is capped at 16000 characters");
}
