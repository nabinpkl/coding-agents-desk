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
  ArenaFolderCheck,
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
import { LIVE_WORKTREE_STEPS, undoWorktrees, type ArenaWorktreeSteps } from "@/arena/arenaWorktrees";
import { StartLine, type ContestantDrivers, type ContestantResume } from "@/arena/contestants/contestantDriver";
import { passText } from "@/arena/contestants/laneStance";
import { killTmuxSession } from "@/terminal/tmux/tmuxSessions";
import { ArenaNextPromptError, nextPromptContestants, passLanes } from "@/arena/arenaTurns";
import { driveContestant, type DriveTurn } from "@/arena/arenaDrive";
import { checkLanes, checkRunRequest, promptProblem } from "@/arena/arenaRequest";
import { LANE_FOLDERS_PATTERN, newLaneRecords } from "@/arena/arenaLanes";
import { MANAGER_FOLDER, type ArenaManagers } from "@/arena/manager/arenaManagers";

/** The request could not become a run; the route answers it with a 400 naming this reason. */
export class ArenaBadRequestError extends Error {}
/** The run id names no run; the route answers with a 404. */
export class ArenaRunNotFoundError extends Error {}
/** The run is still dueling and cannot be torn down; the route answers with a 409. */
export class ArenaRunBusyError extends Error {}

/** How long one contestant's turn may run before the service gives up on it. */
const TURN_TIMEOUT_MS = 10 * 60 * 1000;

export class ArenaService {
  private readonly registry: ArenaRunRegistry;
  private readonly store: ArenaStore;
  private readonly drivers: ContestantDrivers;
  private readonly terminalDrivers: ContestantDrivers | null;
  private readonly managers: ArenaManagers | null;
  private readonly killPane: (pane: string) => Promise<void>;
  private readonly worktrees: ArenaWorktreeSteps;
  private readonly arenaHome: string;
  private readonly turnTimeoutMs: number;
  private readonly newRunId: () => string;
  /** Each live terminals run's start line, and the drives that wait at it, by run id. */
  private readonly lines = new Map<string, StartLine>();
  private readonly drives = new Map<string, Promise<void>[]>();
  /** Runs whose added lanes' worktrees are being made: one addition at a time, and no removal. */
  private readonly adding = new Set<string>();

  constructor(options: {
    registry: ArenaRunRegistry;
    store: ArenaStore;
    /** One headless driver per source this sidecar can duel; the wiring is `arenaWiring.ts`. */
    drivers: ContestantDrivers;
    /** The terminals mode's drivers, or null where this machine has no tmux to run them in. */
    terminalDrivers?: ContestantDrivers | null;
    /** Starts and briefs a run's manager, where there is a tmux for one; `manager/arenaManagers.ts`. */
    managers?: ArenaManagers | null;
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
    this.managers = options.managers ?? null;
    this.killPane = options.killPane ?? killTmuxSession;
    this.worktrees = options.worktrees ?? LIVE_WORKTREE_STEPS;
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

  /** What a run would make of each folder: a repository, a plain folder to make one of, or neither. */
  inspectFolders(paths: readonly string[]): Promise<ArenaFolderCheck[]> {
    return Promise.all(paths.map((path) => this.worktrees.inspectFolder(path)));
  }

  /** What a run asked for with nothing filled in would get here, right now. */
  newRunDefaults(): ArenaNewRunDefaults {
    const nextName = nextRunName(
      this.arenaHome,
      this.registry.list().map((run) => run.name),
    );
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
      // A run before its first prompt keeps a line with no lane on it, so it can still take lanes.
      if (!drivers || (picked.length === 0 && run.round > 0)) continue;
      const line = new StartLine(picked.filter((one) => !one.resume?.prompted).length, run.prompt || null);
      this.lines.set(run.runId, line);
      this.drives.set(
        run.runId,
        picked.map(({ record, resume }) => this.driveOne(run, record, drivers, line, resume ? { resume } : {})),
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
    const { prompt, namedRepo, baseRef, mode, drivers, lanes, manager } = checked;
    if (manager && !this.managers) throw new ArenaBadRequestError("this machine has no tmux for a manager to run in");

    const naming = runNameFor(
      request.name,
      this.arenaHome,
      this.registry.list().map((run) => run.name),
    );
    if ("problem" in naming) throw new ArenaBadRequestError(naming.problem);
    const { name, folderName } = naming;
    // No repository named means the run gets one of its own, made in its folder below; a plain
    // folder named is made one there too, with its files as the base (ADR-0153).
    const named = namedRepo ? await this.worktrees.inspectFolder(namedRepo) : null;
    if (named?.problem) throw new ArenaBadRequestError(`"${namedRepo}" ${named.problem}`);

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

    const records = newLaneRecords(folder, lanes, 0);

    // Every worktree before the run is registered, so a run that reaches the registry is whole:
    // a contestant cannot be handed a prompt for a directory that was never made. A failure
    // halfway undoes the worktrees already made and the folder, and leaves no run behind.
    try {
      if (repoCreated) {
        await this.worktrees.initRepository({
          path: folder,
          message: name,
          worktreeFolders: [LANE_FOLDERS_PATTERN, MANAGER_FOLDER],
        });
      } else if (!named?.repository) {
        // Left a repository if a worktree then fails: it holds the reader's files, and is theirs.
        await this.worktrees.initRepository({
          path: repoPath,
          message: `${name}: the folder as found`,
          worktreeFolders: [],
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
      manager: manager
        ? {
            source: manager,
            status: "starting",
            folder: join(folder, MANAGER_FOLDER),
            sessionId: null,
            tmuxSession: null,
            error: null,
          }
        : null,
    };
    this.registry.add(run);
    // Started with the lanes, so it is up to plan them, or by the time there is anything to judge.
    if (manager) void this.managers!.open(runId);

    // Fanned out, not awaited: the run is live the moment it is registered, and each contestant
    // closes on its own. `void` with the failure handled inside, so a contestant that fails
    // records its failure rather than surfacing as an unhandled rejection.
    const startLine = mode === "terminals" ? new StartLine(records.length, prompt || null) : null;
    if (startLine) this.lines.set(runId, startLine);
    this.drives.set(
      runId,
      records.map((record) => this.driveOne(run, record, drivers, startLine)),
    );
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
    if (run.contestants.length === 0)
      throw new ArenaBadRequestError("this run has no lanes yet: add them before its prompt");
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
   * More lanes for a terminals run before its first prompt: worktrees made, then the lanes opened at
   * its start line to take that prompt with the others. How a manager starts the lanes it planned.
   */
  async addContestants(runId: string, raw: unknown): Promise<ArenaRunSummary> {
    const run = this.registry.get(runId);
    if (!run) throw new ArenaRunNotFoundError(`no arena run "${runId}"`);
    const line = this.lines.get(runId);
    const drivers = this.terminalDrivers;
    const closed = (): boolean =>
      run.mode !== "terminals" || !drivers || !line || line.prompted || !this.registry.get(runId);
    if (closed()) throw new ArenaRunBusyError("lanes are added only to a terminals run before its first prompt");
    if (this.adding.has(runId)) throw new ArenaRunBusyError("this run is already adding lanes");
    const lanes = checkLanes(raw, drivers!, run.contestants.length);
    if ("problem" in lanes) throw new ArenaBadRequestError(lanes.problem);
    if (lanes.length === 0) throw new ArenaBadRequestError("name at least one lane to add");
    const records = newLaneRecords(run.folder, lanes, run.contestants.length);
    this.adding.add(runId);
    try {
      for (const record of records)
        await this.worktrees.add({ repoPath: run.repoPath, path: record.worktreePath, ref: run.baseRef });
      // The prompt may have been given while the worktrees were made; these lanes missed it.
      if (closed()) throw new ArenaRunBusyError("the run was given its prompt while its lanes were being added");
    } catch (error) {
      await undoWorktrees(this.worktrees, run.repoPath, records).catch(() => undefined);
      throw error;
    } finally {
      this.adding.delete(runId);
    }
    for (const _ of records) line!.join();
    this.registry.updateRun(runId, (one) => one.contestants.push(...records));
    const drives = this.drives.get(runId) ?? [];
    drives.push(...records.map((record) => this.driveOne(run, record, drivers!, line!)));
    this.drives.set(runId, drives);
    return runSummary(run);
  }

  /**
   * Passes one lane's latest answer to a lane of the other stance, as that lane's next turn: a for
   * lane's answer to an against lane to critique, or an against lane's critique to a for lane to
   * weigh (`passText`). The run's prompt and round stay as they are; only the lane passed to moves.
   */
  passAnswer(runId: string, raw: unknown): ArenaRunSummary {
    const run = this.registry.get(runId);
    if (!run) throw new ArenaRunNotFoundError(`no arena run "${runId}"`);
    const { from, to } = asRunError(() => passLanes(run, raw));
    const text = passText(from, to, from.answer!);
    const tooLong = promptProblem(text);
    if (tooLong) throw new ArenaBadRequestError(`${from.contestantId}'s answer is too long to pass: ${tooLong}`);
    this.continueLanes(run, [to], text);
    return runSummary(run);
  }

  /**
   * One more prompt for every contestant with a session to continue. A terminals contestant goes
   * back to a start line in the pane it has, as one picked back up after a restart does, so every
   * lane is typed the prompt together; a headless one is driven again into its session.
   */
  private startNextRound(run: ArenaRunRecord, prompt: string): void {
    const continuing = asRunError(() => nextPromptContestants(run));
    this.continueLanes(run, continuing, null, prompt);
  }

  /**
   * Drives the `continuing` lanes again in the sessions they have: with the run's next `prompt` (a round, which
   * moves the run's prompt and round), or with `sent` as it is (a pass, which moves neither).
   *
   * A pass is typed from a start line of its own. A sidecar that restarts in the moment between that
   * line letting the lane go and the text reaching its pane picks the lane back up on the run's
   * prompt instead; the moment is the lane's composer being found, well under a second.
   */
  private continueLanes(
    run: ArenaRunRecord,
    continuing: ArenaContestantRecord[],
    sent: string | null,
    prompt?: string,
  ): void {
    const terminals = run.mode === "terminals";
    const drivers = terminals ? this.terminalDrivers : this.drivers;
    if (!drivers) throw new ArenaBadRequestError("this machine has no tmux to drive a terminals run in");
    this.registry.updateRun(run.runId, (one) => {
      if (prompt !== undefined) {
        one.prompt = prompt;
        one.round += 1;
      }
      for (const contestant of continuing) {
        contestant.status = terminals ? "starting" : "preparing";
        contestant.closedAt = null;
        contestant.error = null;
      }
    });
    const turn = sent === null ? {} : { sent };
    const line = terminals ? new StartLine(continuing.length, sent ?? prompt!) : null;
    if (line) this.lines.set(run.runId, line);
    this.drives.set(
      run.runId,
      continuing.map((record) =>
        terminals
          ? this.driveOne(run, record, drivers, line, {
              ...turn,
              resume: { pane: record.tmuxSession!, sessionId: record.sessionId!, prompted: false },
            })
          : this.driveOne(run, record, drivers, null, { ...turn, continues: record.sessionId! }),
      ),
    );
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
    if (this.adding.has(runId)) throw new ArenaRunBusyError(`run "${runId}" is adding lanes`);
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
    await this.managers?.close(run).catch((error: unknown) => console.error("agent feed arena left a manager", error));
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

  /** One contestant's whole turn (`arenaDrive.ts`), against this service's own registry and store. */
  private driveOne(
    run: ArenaRunRecord,
    record: ArenaContestantRecord,
    drivers: ContestantDrivers,
    startLine: StartLine | null,
    turn: DriveTurn = {},
  ): Promise<void> {
    const steps = {
      registry: this.registry,
      store: this.store,
      worktrees: this.worktrees,
      turnTimeoutMs: this.turnTimeoutMs,
    };
    return driveContestant(steps, run, record, drivers, startLine, turn);
  }
}

/** Runs a check of a run's next turn, as the error the routes map: busy is 409, the rest 400. */
function asRunError<T>(check: () => T): T {
  try {
    return check();
  } catch (error) {
    if (!(error instanceof ArenaNextPromptError)) throw error;
    throw error.busy ? new ArenaRunBusyError(error.message) : new ArenaBadRequestError(error.message);
  }
}
