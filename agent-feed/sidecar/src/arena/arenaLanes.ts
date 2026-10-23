// A run's lanes as the arena first records them: what one contestant is before anything has
// driven it. Shared by a run made whole and by lanes added to it later, so both number and place
// their worktrees the same way.

import { join } from "node:path";
import type { ArenaContestantRecord } from "@/arena/arenaRun";
import type { CheckedLane } from "@/arena/arenaRequest";

/**
 * What keeps every lane's worktree out of a run's own repository: one `info/exclude` pattern for
 * `c1`, `c2` and any lane added later, since the repository is made before the later ones exist.
 */
export const LANE_FOLDERS_PATTERN = "c[0-9]*";

/** Fresh records for `lanes`, numbered on from the `first` lanes the run already has. */
export function newLaneRecords(folder: string, lanes: readonly CheckedLane[], first: number): ArenaContestantRecord[] {
  return lanes.map((lane, index) => {
    const contestantId = `c${first + index + 1}`;
    return {
      contestantId,
      source: lane.source,
      model: lane.model,
      stance: lane.stance,
      sessionId: null,
      worktreePath: join(folder, contestantId),
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
    };
  });
}
