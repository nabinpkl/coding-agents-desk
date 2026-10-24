// Several machines' flat Sessions lists as one.
//
// Each sidecar cuts its own list at the page the panel asked for, newest first
// (`RecentSessionsPayload`), and the panel asks every machine for the same page. Cutting the merge
// at that page again is exact rather than close: a session in the combined first N is in its own
// machine's first N, because every session on its machine that is newer is in the combined first N
// as well.

import type { RecentSession, RecentSessionsPayload } from "@agentdesk/agent-feed-wire";

/** One machine's page, or null until it arrives. `key` is the machine's, absent for the shell's own. */
export interface MachineRecent {
  key?: string;
  recent: RecentSessionsPayload | null;
}

export interface MergedRecent {
  recent: RecentSessionsPayload;
  /** The machine each row came from, by `source:sessionId`, for the rows not from the shell's own. */
  machineOf: ReadonlyMap<string, string>;
}

const keyOf = (session: RecentSession) => `${session.source}:${session.sessionId}`;

/** Newest first, and the machines' own order where two changed at the same moment. */
function newestFirst(rows: readonly RecentSession[], limit: number): { rows: RecentSession[]; cut: boolean } {
  // `sort` is stable, so rows that tie stay in the order the machines were listed in.
  const sorted = [...rows].sort((a, b) => b.lastEventAt - a.lastEventAt);
  return { rows: sorted.slice(0, limit), cut: sorted.length > limit };
}

/**
 * The machines' pages as one, cut at `limit` sessions and `reviewLimit` security reviews.
 *
 * Null until the shell's own machine has answered, the first entry: that is the list the view
 * draws "Loading" for. A peer that has not answered yet, or is not answering, adds nothing and
 * holds nothing back; its rows join when its page arrives.
 */
export function mergeRecentSessions(
  machines: readonly MachineRecent[],
  limit: number,
  reviewLimit: number,
): MergedRecent | null {
  const [home] = machines;
  if (!home?.recent) return null;
  const answered = machines.filter((machine): machine is MachineRecent & { recent: RecentSessionsPayload } =>
    Boolean(machine.recent),
  );
  if (answered.length === 1) return { recent: home.recent, machineOf: new Map() };

  const machineOf = new Map<string, string>();
  for (const machine of answered) {
    if (machine.key === undefined) continue;
    for (const row of [...machine.recent.recent, ...machine.recent.securityReviews.recent]) {
      machineOf.set(keyOf(row), machine.key);
    }
  }
  const sessions = newestFirst(
    answered.flatMap((machine) => machine.recent.recent),
    limit,
  );
  const reviews = newestFirst(
    answered.flatMap((machine) => machine.recent.securityReviews.recent),
    reviewLimit,
  );
  return {
    recent: {
      recent: sessions.rows,
      more: sessions.cut || answered.some((machine) => machine.recent.more),
      securityReviews: {
        count: answered.reduce((sum, machine) => sum + machine.recent.securityReviews.count, 0),
        live: answered.reduce((sum, machine) => sum + machine.recent.securityReviews.live, 0),
        recent: reviews.rows,
        more: reviews.cut || answered.some((machine) => machine.recent.securityReviews.more),
      },
    },
    machineOf,
  };
}
