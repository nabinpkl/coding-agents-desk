// A run's later prompts: who takes the next one, and what each closed turn adds to a contestant's
// facts.
//
// A run never ends. Once every contestant has settled, the reader's next prompt goes to each of them
// in the session it already has -- typed into its pane in the terminals mode, resumed headless --
// so a duel is a conversation held with every lane at once rather than one question. The facts a
// lane shows are the whole conversation's: what each turn read, wrote and reached outside its
// worktree is added to what the turns before it did, and the diff is the worktree as it now stands.

import type { ActivityEvent } from "@/transcripts/transcriptTypes";
import type { ArenaContestantRecord, ArenaRunRecord } from "@/arena/arenaRun";
import { isLiveContestant } from "@/arena/arenaRun";
import { filesFromEvents, outsideReaches } from "@/arena/arenaFacts";

/** Why a run cannot take its next prompt right now, said to the reader as the route's answer. */
export class ArenaNextPromptError extends Error {
  constructor(
    message: string,
    readonly busy: boolean,
  ) {
    super(message);
  }
}

/**
 * The contestants that take a run's next prompt: every one with a session to continue -- and, in
 * the terminals mode, a pane it lives in. A failed contestant is among them when it has both: what
 * failed was a turn, and the session is still there to be asked again.
 *
 * Refused while any contestant is still on the last prompt, since a prompt typed into a pane
 * mid-turn would land in the middle of that turn; and when nobody has a session to continue.
 */
export function nextPromptContestants(run: ArenaRunRecord): ArenaContestantRecord[] {
  if (run.contestants.some(isLiveContestant)) {
    throw new ArenaNextPromptError("the lanes are still on the last prompt; send the next one once they settle", true);
  }
  const continuing = run.contestants.filter(
    (contestant) => contestant.sessionId !== null && (run.mode === "headless" || contestant.tmuxSession !== null),
  );
  if (continuing.length === 0) {
    throw new ArenaNextPromptError("no contestant has a session to continue", false);
  }
  return continuing;
}

/**
 * A contestant's file facts once one more turn has closed: the files and reaches it already had,
 * then this turn's that are new, in first-mention order.
 *
 * Merged rather than replaced because a harness reports its turn differently: Claude's events come
 * from its whole transcript, the serve's from the turn alone. A union is the same answer either way.
 */
export function factsAfterTurn(
  record: Pick<
    ArenaContestantRecord,
    "filesRead" | "filesWritten" | "outsideReached" | "worktreePath" | "contestantId"
  >,
  events: readonly ActivityEvent[],
  run: Pick<ArenaRunRecord, "contestants">,
  home: string,
): Pick<ArenaContestantRecord, "filesRead" | "filesWritten" | "outsideReached"> {
  const turn = filesFromEvents(events);
  const reached = outsideReaches(events, {
    worktreePath: record.worktreePath,
    rivals: run.contestants.filter((one) => one.contestantId !== record.contestantId),
    home,
  });
  const seen = new Set(record.outsideReached.map((reach) => `${reach.how}\0${reach.path}`));
  return {
    filesRead: [...new Set([...record.filesRead, ...turn.filesRead])],
    filesWritten: [...new Set([...record.filesWritten, ...turn.filesWritten])],
    outsideReached: [...record.outsideReached, ...reached.filter((reach) => !seen.has(`${reach.how}\0${reach.path}`))],
  };
}
