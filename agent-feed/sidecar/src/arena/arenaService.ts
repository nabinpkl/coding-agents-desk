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
  ArenaCreateRunRequest,
  ArenaNewRunDefaults,
  ArenaRunDetail,
  ArenaRunMode,
  ArenaRunSummary,
} from "@agentdesk/agent-feed-wire";
import {
  afterRestart,
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
  undoWorktrees,
  type ArenaWorktreeSteps,
} from "@/arena/arenaWorktrees";
import {
  StartLine,
  startLineTerminal,
  type ContestantDriver,
  type ContestantDrivers,
  type ContestantPlan,
  type ContestantResume,
} from "@/arena/contestants/contestantDriver";
import { killTmuxSession } from "@/terminal/tmux/tmuxSessions";
import { homedir } from "node:os";
import { ArenaNextPromptError, factsAfterTurn, nextPromptContestants } from "@/arena/arenaTurns";
import { checkRunRequest, promptProblem } from "@/arena/arenaRequest";

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
   * Picks back up what a restart interrupted, once, right after the service is made: every
   * unfinished contestant is driven again or failed with why (`afterRestart`). A terminals run's
   * picked-up contestants get a start line of their own, which still holds the ones not yet let
   * go and still takes the prompt of a run that had none.
   */
  resumeInterruptedRuns(): void {
    for (const run of this.registry.list()) {
      const picked: { record: ArenaContestantRecord; resume: ContestantResume | null }[] = [];
      for (const record of run.contestants.filter(isLiveContestant)) {
        const outcome = afterRestart(run, record, this.terminalDrivers !== null);
        if ("drive" in outcome) {
          picked.push({ record, resume: outcome.drive });
          continue;
        }
        this.registry.updateContestant(run.runId, record.contestantId, (contestant, now) => {
          contestant.status = "failed";
          contestant.closedAt = now;
          contestant.error = outcome.failed;
        });
      }
      const drivers = this.terminalDrivers;
      if (picked.length === 0 || !drivers) continue;
      const line = new StartLine(picked.filter((one) => !one.resume?.prompted).length, run.prompt || null);
      this.lines.set(run.runId, line);
      this.drives.set(
        run.runId,
        picked.map(({ record, resume }) => this.driveOne(run, record, drivers, line, resume ?? undefined)),
      );
    }
  }

  /**
   * Validates the request, makes the run's folder (and, when it names no repository, the run's
   * own repository there), makes every contestant's worktree in it, registers the run, and fans
   * the prompt out in the background. The answer is the run as it stands at the moment of asking:
   * every contestant preparing, none yet running.
   */
  async createRun(request: ArenaCreateRunRequest): Promise<ArenaRunSummary> {
    const checked = checkRunRequest(request, {
      modes: this.modes(),
      driversFor: (mode) => (mode === "terminals" ? this.terminalDrivers : this.drivers),
    });
    if ("problem" in checked) throw new ArenaBadRequestError(checked.problem);
    const { prompt, namedRepo, baseRef, mode, drivers, sources } = checked;

    const naming = runNameFor(request.name, this.arenaHome, this.registry.list().map((run) => run.name));
    if ("problem" in naming) throw new ArenaBadRequestError(naming.problem);
    const { name, folderName } = naming;
    // No repository named means the run gets one of its own, made in its folder below.
    if (namedRepo) {
      if (!isAbsolute(namedRepo)) throw new ArenaBadRequestError(`repoPath must be absolute: "${namedRepo}"`);
      await this.worktrees.assertRepository(namedRepo);
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

    const records: ArenaContestantRecord[] = sources.map((source, index) => ({
      contestantId: `c${index + 1}`,
      source,
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
      outsideReached: [],
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
      await undoWorktrees(this.worktrees, repoPath, records).catch(() => undefined);
      this.releaseFolder(folder, repoCreated);
      throw error;
    }

    const run: ArenaRunRecord = {
      runId,
      name,
      folder,
      prompt,
      round: prompt ? 1 : 0,
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
   * Gives a run its next prompt. A terminals run whose lanes are open and waiting gets its first,
   * typed into every lane together once all of them are ready. Any run whose contestants have all
   * settled gets the next one in the sessions they already have (`arenaTurns.ts`): a run never
   * ends, it waits for the reader.
   */
  sendPrompt(runId: string, raw: unknown): ArenaRunSummary {
    const run = this.registry.get(runId);
    if (!run) throw new ArenaRunNotFoundError(`no arena run "${runId}"`);
    const prompt = typeof raw === "string" ? raw.trim() : "";
    if (!prompt) throw new ArenaBadRequestError("a prompt cannot be empty");
    const tooLong = promptProblem(prompt);
    if (tooLong) throw new ArenaBadRequestError(tooLong);
    const line = this.lines.get(runId);
    if (!run.prompt && line && !line.prompted) {
      this.registry.updateRun(runId, (one) => {
        one.prompt = prompt;
        one.round = 1;
      });
      line.give(prompt);
      return runSummary(run);
    }
    if (!run.prompt) throw new ArenaBadRequestError("this run's lanes closed before they were given a prompt");
    this.startNextRound(run, prompt);
    return runSummary(run);
  }

  /**
   * One more prompt for every contestant with a session to continue. A terminals contestant goes
   * back to a start line in the pane it has, as one picked back up after a restart does, so every
   * lane is typed the prompt together; a headless one is driven again into its session.
   */
  private startNextRound(run: ArenaRunRecord, prompt: string): void {
    let continuing: ArenaContestantRecord[];
    try {
      continuing = nextPromptContestants(run);
    } catch (error) {
      if (!(error instanceof ArenaNextPromptError)) throw error;
      throw error.busy ? new ArenaRunBusyError(error.message) : new ArenaBadRequestError(error.message);
    }
    const terminals = run.mode === "terminals";
    const drivers = terminals ? this.terminalDrivers : this.drivers;
    if (!drivers) throw new ArenaBadRequestError("this machine has no tmux to drive a terminals run in");
    this.registry.updateRun(run.runId, (one) => {
      one.prompt = prompt;
      one.round += 1;
      for (const contestant of continuing) {
        contestant.status = terminals ? "starting" : "preparing";
        contestant.closedAt = null;
        contestant.error = null;
      }
    });
    const line = terminals ? new StartLine(continuing.length, prompt) : null;
    if (line) this.lines.set(run.runId, line);
    this.drives.set(run.runId, continuing.map((record) =>
      terminals
        ? this.driveOne(run, record, drivers, line, { pane: record.tmuxSession!, sessionId: record.sessionId!, prompted: false })
        : this.driveOne(run, record, drivers, null, undefined, record.sessionId!)
    ));
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
    await undoWorktrees(this.worktrees, run.repoPath, run.contestants);
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
    resume?: ContestantResume,
    continues?: string,
  ): Promise<void> {
    const mark = (apply: (contestant: ArenaContestantRecord, now: number) => void): void => {
      this.registry.updateContestant(run.runId, record.contestantId, apply);
    };
    const atLine = startLine
      ? startLineTerminal({
        label: `arena ${record.contestantId} ${run.runId.slice(0, 8)}`,
        line: startLine,
        ...(resume ? { resume } : {}),
        marks: {
          pane: (pane, sessionId) => mark((contestant) => {
            contestant.tmuxSession = pane;
            contestant.sessionId = sessionId;
            contestant.status = "starting";
          }),
          ready: () => mark((contestant) => {
            contestant.status = "ready";
          }),
          running: () => mark((contestant, now) => {
            contestant.status = "running";
            contestant.startedAt = now;
          }),
        },
      })
      : null;
    const terminal = atLine?.terminal;
    try {
      const drive: ContestantDriver | undefined = drivers[record.source];
      // createRun refused every source without a driver, so this is a broken invariant.
      if (!drive) throw new Error(`no driver wired for source "${record.source}"`);
      const plan: ContestantPlan = {
        prompt: run.prompt,
        worktreePath: record.worktreePath,
        // One per prompt, not per contestant: a harness deduplicates a send by it, so a later
        // prompt under the first one's id would be refused as the same command sent again.
        requestId: `${run.runId}:${record.contestantId}:${run.round}`,
        turnTimeoutMs: this.turnTimeoutMs,
        ...(terminal ? { terminal } : {}),
        ...(continues ? { continues } : {}),
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

      const facts = factsAfterTurn(record, result.events, run, homedir());
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
        Object.assign(contestant, facts);
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
      atLine?.done();
    }
  }
}

