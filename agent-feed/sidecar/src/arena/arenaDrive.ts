// One contestant's turn in an arena run, from its prompt to the facts it left.
//
// Apart from the service because it is the one part of a run that is a sequence rather than a
// decision: the service decides who is driven and when, and this drives one of them and writes
// down each state it passes through.

import { homedir } from "node:os";
import type { ArenaContestantRecord, ArenaRunRecord, ArenaRunRegistry } from "@/arena/arenaRun";
import type { ArenaStore } from "@/arena/arenaStore";
import { boundedDiff, type ArenaWorktreeSteps } from "@/arena/arenaWorktrees";
import {
  startLineTerminal,
  type ContestantDriver,
  type ContestantDrivers,
  type ContestantPlan,
  type ContestantResume,
  type StartLine,
} from "@/arena/contestants/contestantDriver";
import { factsAfterTurn } from "@/arena/arenaTurns";

/** What a turn writes to and reads from: the service's own, handed over. */
export interface ArenaDriveSteps {
  registry: ArenaRunRegistry;
  store: ArenaStore;
  worktrees: ArenaWorktreeSteps;
  turnTimeoutMs: number;
}

/**
 * One contestant's whole turn: send the prompt, wait for the close, record the facts.
 *
 * Every state it passes through is written to the record as it happens, so a run is watchable
 * from its first moment and a contestant that dies mid-turn leaves its failure where the
 * reader is already looking.
 */
export async function driveContestant(
  steps: ArenaDriveSteps,
  run: ArenaRunRecord,
  record: ArenaContestantRecord,
  drivers: ContestantDrivers,
  startLine: StartLine | null,
  resume?: ContestantResume,
  continues?: string,
): Promise<void> {
  const mark = (apply: (contestant: ArenaContestantRecord, now: number) => void): void => {
    steps.registry.updateContestant(run.runId, record.contestantId, apply);
  };
  const atLine = startLine
    ? startLineTerminal({
        label: `arena ${record.contestantId} ${run.runId.slice(0, 8)}`,
        line: startLine,
        ...(resume ? { resume } : {}),
        marks: {
          pane: (pane, sessionId) =>
            mark((contestant) => {
              contestant.tmuxSession = pane;
              contestant.sessionId = sessionId;
              contestant.status = "starting";
            }),
          ready: () =>
            mark((contestant) => {
              contestant.status = "ready";
            }),
          running: () =>
            mark((contestant, now) => {
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
      model: record.model,
      // One per prompt, not per contestant: a harness deduplicates a send by it, so a later
      // prompt under the first one's id would be refused as the same command sent again.
      requestId: `${run.runId}:${record.contestantId}:${run.round}`,
      turnTimeoutMs: steps.turnTimeoutMs,
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
    const bounded = boundedDiff(
      await steps.worktrees.captureDiff({ worktreePath: record.worktreePath, ref: run.baseRef }),
    );
    steps.store.writeContestantDiff(run.runId, record.contestantId, bounded);
    steps.registry.updateContestant(run.runId, record.contestantId, (contestant, now) => {
      contestant.status = "closed";
      contestant.closedAt = now;
      contestant.contextTokens = result.usage?.current ?? null;
      contestant.costUsd = result.usage?.cost ?? null;
      Object.assign(contestant, facts);
      contestant.gitDiff = bounded;
    });
  } catch (error) {
    steps.registry.updateContestant(run.runId, record.contestantId, (contestant, now) => {
      contestant.status = "failed";
      contestant.closedAt = now;
      contestant.error = error instanceof Error ? error.message : String(error);
    });
  } finally {
    // A contestant that never reached the start line is out of the race, so nobody waits on it.
    atLine?.done();
  }
}
