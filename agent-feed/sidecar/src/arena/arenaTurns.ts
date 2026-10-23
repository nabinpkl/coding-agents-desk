// A run's later prompts: who takes the next one, and what each closed turn adds to a contestant's
// facts.
//
// A run never ends. Once every contestant has settled, the reader's next prompt goes to each of them
// in the session it already has -- typed into its pane in the terminals mode, resumed headless --
// so a duel is a conversation held with every lane at once rather than one question. The facts a
// lane shows are the whole conversation's: what each turn read, wrote and reached outside its
// worktree is added to what the turns before it did, and the diff is the worktree as it now stands.
//
// A pass is the one turn that goes to a single lane: another lane's latest answer, sent across
// stances (`laneStance.ts` words it). It is checked here like a prompt, and waits for the same thing.

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

/**
 * The text a turn ended with, read off its events: what the lane said after its last tool call, or
 * everything it said in the turn when it said nothing after one. Null when it said nothing.
 *
 * The turn starts after the last prompt a person (or a pass) gave it. Claude's events are its whole
 * transcript and flag that prompt `humanTurn`; when no event carries the flag, a user event with
 * text stands in for it, which is what a turn's own events hold.
 */
export function lastAnswer(events: readonly ActivityEvent[]): string | null {
  const flagged = events.some((event) => event.humanTurn === true);
  const isPrompt = (event: ActivityEvent): boolean =>
    event.type === "user" && (flagged ? event.humanTurn === true : event.blocks.some((block) => block.kind === "text"));
  const start = events.findLastIndex(isPrompt) + 1;
  const turn = events.slice(start);
  const afterTools =
    turn.findLastIndex((event) =>
      event.blocks.some((block) => block.kind === "tool_use" || block.kind === "tool_result"),
    ) + 1;
  const said = (from: number): string[] =>
    turn
      .slice(from)
      .filter((event) => event.type === "assistant")
      .flatMap((event) => event.blocks)
      .flatMap((block) => (block.kind === "text" && block.text?.trim() ? [block.text.trim()] : []));
  const tail = said(afterTools);
  const answer = (tail.length > 0 ? tail : said(0)).join("\n\n");
  return answer || null;
}

/**
 * The two lanes a pass names, or why it cannot go now: both must be lanes of the run, of different
 * stances; the one passed from must have an answer and the one passed to a session to continue;
 * and, as for a prompt, every lane must have settled.
 */
export function passLanes(
  run: ArenaRunRecord,
  raw: unknown,
): { from: ArenaContestantRecord; to: ArenaContestantRecord } {
  const { from: fromId, to: toId } = (raw ?? {}) as { from?: unknown; to?: unknown };
  const lane = (id: unknown, role: string): ArenaContestantRecord => {
    const found = run.contestants.find((one) => one.contestantId === id);
    if (!found)
      throw new ArenaNextPromptError(`the lane to pass ${role} names "${String(id)}", which this run has not`, false);
    return found;
  };
  const from = lane(fromId, "from");
  const to = lane(toId, "to");
  if (from.stance === to.stance) {
    throw new ArenaNextPromptError("a pass goes between a lane for the prompt and a lane against it", false);
  }
  if (run.contestants.some(isLiveContestant)) {
    throw new ArenaNextPromptError("the lanes are still on their last turn; pass once they settle", true);
  }
  if (from.answer === null) throw new ArenaNextPromptError(`${from.contestantId} has no answer to pass yet`, false);
  if (to.sessionId === null || (run.mode === "terminals" && to.tmuxSession === null)) {
    throw new ArenaNextPromptError(`${to.contestantId} has no session to continue`, false);
  }
  return { from, to };
}
