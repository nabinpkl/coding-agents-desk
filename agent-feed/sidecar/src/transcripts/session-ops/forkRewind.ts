/**
 * Moving a just-started fork back to the message it was asked to start from.
 *
 * Its own module rather than a function inside `forkSession.ts`, for two reasons that turned out
 * to be the same one. It is the only part of forking that drives a PANE -- everything else is a
 * catalog read and a process launch -- so keeping it here is what stops the fork's own module
 * importing half of `input/`. And it is the part a test has to stand in for: a route test that
 * reached the real one would wait a minute on a tmux that has no such session, so it replaces this
 * module, and this module is not one the composer's own tests import.

 * That second point is a scar rather than a preference. Replacing a module replaces it for every
 * test in the run, so a route test that stood in for the composer's verbs silently answered the
 * composer's own tests too, and nineteen of them started passing for the wrong reason.
 */
import {
  awaitComposer,
  submitTmuxComposer,
  syncTmuxComposer,
} from "@/input/tmuxComposer";
import { rewindTmuxSession } from "@/input/rewindPicker";
import { forkFirstTurn } from "@/terminal/session-panes/claudeSessionLaunch";
import type { RewindRefusal } from "@/input/rewindPicker";
import type { MessageAnchor } from "@/transcripts/messageAnchor";

/**
 * How long a fork is given to come up before its rewind is abandoned.
 *
 * Generous because the thing being waited for is a Claude CLI starting AND loading the whole
 * transcript it was forked from, which is seconds for a long session. Bounded because the caller
 * is an HTTP request holding a reader's dialog open: past this the honest answer is that the fork
 * exists and did not get moved.
 */
const FORK_READY_LIMIT_MS = 60_000;

/**
 * Waits for the fork to be up, moves it, then gives it its first turn.
 *
 * The brief is delivered HERE rather than on the command line, and only when there is a rewind to
 * do. The CLI takes a positional prompt as the session's first turn, which would run it against
 * the whole inherited context -- the exact thing the rewind exists to avoid -- so a fork that is
 * being moved gets its brief typed into the box afterwards instead.
 *
 * Nothing clears the box when there is no brief. Rewinding leaves the rewound-to message sitting
 * there, which is Claude's own design and a useful one: it is the message the reader chose, ready
 * to be edited into a different one.
 *
 * And a brief withheld for a rewind that then refuses is PUT IN THE BOX rather than dropped. That
 * was this module's worst behaviour and it was invisible: the reader wrote a brief into the fork
 * dialog, the rewind refused for a reason the panel reported honestly, and the words they had
 * typed were gone with nothing saying so. Unsent, because the whole reason the rewind was asked
 * for is that this context is not the one the brief was written against -- so the fork stops with
 * the reader's own words in front of them and lets them decide.
 */
export async function LIVE_FORK_REWINDER(options: {
  sessionId: string;
  anchor: MessageAnchor;
  prompt?: string;
}): Promise<{ done: true } | { done: false; reason: string }> {
  const { sessionId, anchor, prompt } = options;
  if (!await awaitComposer(sessionId, FORK_READY_LIMIT_MS)) {
    return { done: false, reason: "the fork did not finish starting in time" };
  }
  const outcome = await rewindTmuxSession(sessionId, anchor);
  if (!outcome.rewound) {
    return { done: false, reason: `rewind refused: ${outcome.reason}${await keepBrief(sessionId, prompt, outcome.reason)}` };
  }
  if (!prompt) return { done: true };
  // Through the composer's own path, which replaces whatever the box holds rather than appending
  // to the message the rewind just put back in it.
  const typed = await syncTmuxComposer(sessionId, forkFirstTurn(prompt));
  if (typed.reason !== null) return { done: false, reason: `brief not delivered: ${typed.reason}` };
  await submitTmuxComposer(sessionId);
  return { done: true };
}

/**
 * Leaves a withheld brief in the fork's box after a rewind that refused, and says so.
 *
 * Two refusals are not written into: `composer-busy` means somebody else's text is in that box,
 * and replacing it would be this feature destroying a person's draft to report its own failure;
 * the two that mean there is no reachable pane have nowhere to put anything. Every other refusal
 * happens after `drive` has already established the box was empty, so the worst it holds by then
 * is the `/rewind` this typed, which the composer's own path replaces rather than appends to.
 */
async function keepBrief(
  sessionId: string,
  prompt: string | undefined,
  reason: RewindRefusal,
): Promise<string> {
  if (!prompt) return "";
  if (reason === "composer-busy" || reason === "no-pane" || reason === "tmux-unavailable") {
    return ", and your message could not be put anywhere, so it is in this dialog only";
  }
  const typed = await syncTmuxComposer(sessionId, forkFirstTurn(prompt));
  return typed.reason === null
    ? ", and your message is in the fork's box, unsent"
    : `, and your message could not be put there either: ${typed.reason}`;
}
