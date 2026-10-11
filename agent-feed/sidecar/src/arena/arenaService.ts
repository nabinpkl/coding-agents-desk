// One arena run's life: validate the request, make the worktrees, fan the prompt out to every
// contestant at once, and record what each did.
//
// The service is the only writer of runs: routes talk to it, and it talks to the worktrees, the
// opencode backend, the registry and the store, so a run's state has one owner while it lives.
// Contestants are driven in the background and never block the request that started them --
// a run that waited for its slowest contestant would answer the panel a minute late with
// nothing to show but the wait. Their failures land on the contestant's record, not the run's:
// one contestant failing is a fact about that contestant, and the run is the grouping.
//
// v0 drives opencode contestants only, and says so by refusing anything else with a 400 that
// names the source it could not drive. The Claude driver lands behind the same `driveOne`
// call when its verification arc opens; until then there is one way to duel.

import { randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";
import type {
  ArenaCreateRunRequest,
  ArenaRunDetail,
  ArenaRunSummary,
} from "@agentdesk/agent-feed-wire";
import {
  ArenaRunRegistry,
  runDetail,
  runSummary,
  type ArenaContestantRecord,
  type ArenaRunRecord,
} from "@/arena/arenaRun";
import { ArenaStore } from "@/arena/arenaStore";
import {
  addContestantWorktree,
  assertGitRepository,
  captureWorktreeDiff,
  pruneWorktrees,
  removeContestantWorktree,
} from "@/arena/arenaWorktrees";
import { runOpencodeContestant, type OpencodeContestantBackend } from "@/arena/opencodeContestant";
import type { ActivityBlock, ActivityEvent } from "@/transcripts/transcriptTypes";

/** The request could not become a run; the route answers it with a 400 naming this reason. */
export class ArenaBadRequestError extends Error {}
/** The run id names no run; the route answers with a 404. */
export class ArenaRunNotFoundError extends Error {}
/** The run is still dueling and cannot be torn down; the route answers with a 409. */
export class ArenaRunBusyError extends Error {}

/**
 * The tools a contestant's tools name files by, as the arena counts them. Write-like tools are
 * listed and everything else that names files reads: the arena records what a contestant
 * touched, and which direction the touch went is the one classification it needs.
 */
const WRITE_TOOLS = new Set(["write", "edit", "patch"]);

/** A diff longer than this is truncated with a marker, in memory and in its file alike. */
const MAXIMUM_DIFF_BYTES = 256 * 1024;

/** How long one contestant's turn may run before the service gives up on it. */
const TURN_TIMEOUT_MS = 10 * 60 * 1000;

/** The most contestants one run may fan out to; past this a run stops being watchable. */
const MAXIMUM_CONTESTANTS = 8;

/** The worktree steps, as the service needs them; injected so its tests can fake git. */
export interface ArenaWorktreeSteps {
  assertRepository(repoPath: string): Promise<void>;
  add(options: { repoPath: string; path: string; ref: string }): Promise<void>;
  remove(options: { repoPath: string; path: string }): Promise<void>;
  prune(repoPath: string): Promise<void>;
  captureDiff(options: { worktreePath: string; ref: string }): Promise<string>;
}

/** The pieces `driveOne` needs from the mapper's blocks, as one narrow shape for tests. */
export interface ContestantEvents {
  events: ActivityEvent[];
  usage: { current: number; cost?: number } | null;
  sessionId: string;
}

export class ArenaService {
  private readonly registry: ArenaRunRegistry;
  private readonly store: ArenaStore;
  private readonly backend: OpencodeContestantBackend;
  private readonly worktrees: ArenaWorktreeSteps;
  private readonly arenaRoot: string;
  private readonly defaultRepoPath: string | null;
  private readonly turnTimeoutMs: number;
  private readonly newRunId: () => string;

  constructor(options: {
    registry: ArenaRunRegistry;
    store: ArenaStore;
    backend: OpencodeContestantBackend;
    /** Overridden in tests; the real steps are this module's own `arenaWorktrees.ts`. */
    worktrees?: ArenaWorktreeSteps;
    arenaRoot: string;
    defaultRepoPath: string | null;
    turnTimeoutMs?: number;
    newRunId?: () => string;
  }) {
    this.registry = options.registry;
    this.store = options.store;
    this.backend = options.backend;
    this.worktrees = options.worktrees ?? {
      assertRepository: assertGitRepository,
      add: addContestantWorktree,
      remove: removeContestantWorktree,
      prune: pruneWorktrees,
      captureDiff: captureWorktreeDiff,
    };
    this.arenaRoot = options.arenaRoot;
    this.defaultRepoPath = options.defaultRepoPath;
    this.turnTimeoutMs = options.turnTimeoutMs ?? TURN_TIMEOUT_MS;
    this.newRunId = options.newRunId ?? randomUUID;
    // One persistence owner: every registry change saves the whole index, so a sidecar that
    // dies mid-run leaves on disk every run whose contestants had already closed.
    this.registry.onChange(() => this.store.save(this.registry.list()));
  }

  onRunsChanged(listener: () => void): () => void {
    return this.registry.onChange(listener);
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
   * Validates the request, makes every contestant's worktree, registers the run, and fans the
   * prompt out in the background. The answer is the run as it stands at the moment of asking:
   * every contestant preparing, none yet running.
   */
  async createRun(request: ArenaCreateRunRequest): Promise<ArenaRunSummary> {
    const prompt = typeof request.prompt === "string" ? request.prompt.trim() : "";
    if (!prompt) throw new ArenaBadRequestError("a run needs a prompt");
    if (prompt.length > 16_000) throw new ArenaBadRequestError("a run's prompt is capped at 16000 characters");

    const repoPath = typeof request.repoPath === "string" && request.repoPath.trim()
      ? request.repoPath.trim()
      : this.defaultRepoPath;
    if (!repoPath) throw new ArenaBadRequestError("a run needs a repository; pass repoPath");
    if (!isAbsolute(repoPath)) throw new ArenaBadRequestError(`repoPath must be absolute: "${repoPath}"`);
    await this.worktrees.assertRepository(repoPath);

    const baseRef = typeof request.baseRef === "string" && request.baseRef.trim()
      ? request.baseRef.trim()
      : "HEAD";

    if (!Array.isArray(request.contestants) || request.contestants.length === 0) {
      throw new ArenaBadRequestError("a run needs at least one contestant");
    }
    if (request.contestants.length > MAXIMUM_CONTESTANTS) {
      throw new ArenaBadRequestError(`a run fans out to at most ${MAXIMUM_CONTESTANTS} contestants`);
    }
    for (const [index, contestant] of request.contestants.entries()) {
      if (!contestant || contestant.source !== "opencode") {
        throw new ArenaBadRequestError(
          `contestant ${index} names source "${contestant?.source ?? "none"}", which this arena cannot drive`,
        );
      }
    }

    const runId = this.newRunId();
    if (!/^[0-9a-f-]{36}$/.test(runId)) {
      throw new ArenaBadRequestError("a run id must be a uuid");
    }
    const worktreeRoot = join(this.arenaRoot, runId);

    const records: ArenaContestantRecord[] = request.contestants.map((_, index) => ({
      contestantId: `c${index + 1}`,
      source: "opencode" as const,
      sessionId: null,
      worktreePath: join(worktreeRoot, `c${index + 1}`),
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
    // halfway undoes the worktrees already made and leaves no run behind.
    try {
      for (const record of records) {
        await this.worktrees.add({ repoPath, path: record.worktreePath, ref: baseRef });
      }
    } catch (error) {
      await this.undoWorktrees(repoPath, records).catch(() => undefined);
      throw error;
    }

    const run: ArenaRunRecord = {
      runId,
      prompt,
      repoPath,
      baseRef,
      createdAt: Date.now(),
      contestants: records,
    };
    this.registry.add(run);

    // Fanned out, not awaited: the run is live the moment it is registered, and each contestant
    // closes on its own. `void` with the failure handled inside, so a contestant that fails
    // records its failure rather than surfacing as an unhandled rejection.
    for (const record of records) {
      void this.driveOne(run, record);
    }
    return runSummary(run);
  }

  /**
   * Tears a finished run down: worktrees back to the repository, registrations pruned, the run's
   * directory under the arena root deleted, the record dropped. A run with a contestant still
   * preparing or running is refused -- its worktree holds a live contestant whose work this
   * would delete underneath it.
   */
  async deleteRun(runId: string): Promise<void> {
    const run = this.registry.get(runId);
    if (!run) throw new ArenaRunNotFoundError(`no arena run "${runId}"`);
    if (run.contestants.some((c) => c.status === "preparing" || c.status === "running")) {
      throw new ArenaRunBusyError(`run "${runId}" still has a contestant dueling`);
    }
    await this.undoWorktrees(run.repoPath, run.contestants);
    this.store.deleteRunDirectory(runId);
    this.registry.remove(runId);
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
  private async driveOne(run: ArenaRunRecord, record: ArenaContestantRecord): Promise<void> {
    const mark = (apply: (contestant: ArenaContestantRecord, now: number) => void): void => {
      this.registry.updateContestant(run.runId, record.contestantId, apply);
    };
    try {
      const result = await runOpencodeContestant(this.backend, {
        prompt: run.prompt,
        worktreePath: record.worktreePath,
        requestId: `${run.runId}:${record.contestantId}`,
        turnTimeoutMs: this.turnTimeoutMs,
        onSessionId: (sessionId) => {
          mark((contestant, now) => {
            // The session exists from here, so a reader can open it while it duels; the turn
            // has not run yet, which is why the status says running rather than closed.
            contestant.sessionId = sessionId;
            contestant.startedAt = now;
            contestant.status = "running";
          });
        },
      });

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
    }
  }
}

/**
 * The input keys a file tool names its file by, across the sources this arena drives.
 *
 * The opencode serve's `read` says `path`; Claude's `Read` says `file_path`; a notebook tool
 * says `notebook_path`. The list is what each source's own transcript shape demands, and a
 * source whose tools name a file a fifth way lands here in the same change.
 */
const FILE_INPUT_KEYS = ["path", "file_path", "filePath", "notebook_path"] as const;

function fileFromToolInput(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const record = input as Record<string, unknown>;
  for (const key of FILE_INPUT_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

/**
 * The files a contestant's tools named, from the events its turn produced.
 *
 * `files` on a tool_use block is the adapter's own resolution of what the call named, so that
 * is read first and never re-derived. But the opencode mapper resolves `files` only from the
 * attachments a tool carried -- measured on this machine's serve, a `read` call names its
 * file in its input alone -- so the tool's own input is the fallback, by the keys above. A
 * tool that names no file either way is left alone: a shell command or a glob pattern is a
 * fact the transcript holds, not a file the arena counts.
 */
export function filesFromEvents(events: readonly ActivityEvent[]): {
  filesRead: string[];
  filesWritten: string[];
} {
  const read = new Set<string>();
  const written = new Set<string>();
  for (const event of events) {
    for (const block of event.blocks as ActivityBlock[]) {
      if (block.kind !== "tool_use" || !block.tool) continue;
      const named = block.files && block.files.length > 0
        ? block.files
        : [fileFromToolInput(block.input)].filter((file): file is string => file !== null);
      if (named.length === 0) continue;
      const into = WRITE_TOOLS.has(block.tool) ? written : read;
      for (const file of named) into.add(file);
    }
  }
  return { filesRead: [...read], filesWritten: [...written] };
}
