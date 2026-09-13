// What the summarizer is shown: one turn's events, and the files those events changed.
//
// Both come from the transcript. An earlier version also ran `git diff` and put the working tree
// in the prompt, on the reasoning that the transcript says what the agent CLAIMED and the tree
// says what is actually on disk. The tree turned out to be the wrong source for this question:
// it holds whatever other sessions and the person have done before and since, and the first real
// digest confidently attributed another session's uncommitted files to the turn it was reading.
// A turn's own Write and Edit calls cannot be anyone else's.
//
// Nothing here calls a model. This module is pure enough to test against a fake page reader,
// which is the whole reason the model-facing half is a separate file.

import type { SummaryCoverage, SummaryFileChange } from "@agentdesk/agent-feed-wire";
import type { ActivityEvent, EventMode } from "@/transcripts/transcriptTypes";
import { renderEvent } from "@/summary/summaryPrompt";
import { filesTouchedIn } from "@/summary/toolCalls";

/**
 * How many events one page of the backwards walk reads.
 *
 * Deliberately not `TIMELINE_WINDOW`. That constant is about what a READER is shown -- the window a
 * thread opens on, and the bound past which they are handed that window instead of the rows that
 * got there. This one sizes an internal scan, and tying them would make a change to either of
 * those silently change how far back the summarizer looks for a turn boundary.
 */
const SCAN_PAGE = 100;

/**
 * How many pages back to look for the turn boundary before giving up and summarizing what was
 * found. A turn longer than 1,000 events is past the token ceiling anyway, so walking further
 * would only buy a more precise `fromEventIndex` on a window that is about to be truncated.
 */
const MAX_SCAN_PAGES = 10;

/** Rough tokens-per-character. Deliberately pessimistic: overestimating truncates a little early,
 *  underestimating gets the request refused by the model, and only one of those is recoverable. */
const CHARS_PER_TOKEN = 3.5;

/** Reads one page of a session's events. Injected so this module never learns whether the
 *  session is backed by a transcript on disk or by an agent backend -- the route already knows. */
export type PageReader = (
  offset: number,
  limit: number,
) => Promise<{ events: ActivityEvent[]; total: number } | null>;

export interface TurnWindow {
  /** The events the summarizer will be shown, oldest first, starting at the user message. */
  events: ActivityEvent[];
  coverage: SummaryCoverage;
  /** Read from the events above, so it describes the same window the digest describes. */
  filesTouched: SummaryFileChange[];
}

export interface TurnWindowOptions {
  /** Only so file paths can be named relative to it. Nothing here reads the checkout. */
  project: string;
  mode: EventMode;
  readPage: PageReader;
  tokenCeiling: number;
}

/**
 * The window from the most recent message a PERSON sent to the end of the transcript.
 *
 * Returns null only when the session has no events at all. A session whose last user message
 * cannot be found within the scan limit still yields a window -- the deepest page reached --
 * because "here is the last thousand events" is a better answer than nothing, and `coverage`
 * says exactly what was seen.
 */
export async function resolveTurnWindow(options: TurnWindowOptions): Promise<TurnWindow | null> {
  const { readPage, mode, tokenCeiling } = options;

  const first = await readPage(Math.max(0, 0), SCAN_PAGE);
  if (!first) return null;
  const total = first.total;
  if (total === 0) return null;

  const collected: ActivityEvent[] = [];
  let boundaryFound = false;
  let offset = Math.max(0, total - SCAN_PAGE);
  for (let page = 0; page < MAX_SCAN_PAGES; page += 1) {
    const limit = Math.min(SCAN_PAGE, total - offset);
    const read = limit > 0 ? await readPage(offset, limit) : null;
    const events = read?.events ?? [];
    collected.unshift(...events);
    const boundary = lastHumanIndex(collected);
    if (boundary !== -1) {
      collected.splice(0, boundary);
      boundaryFound = true;
      break;
    }
    if (offset === 0) break;
    offset = Math.max(0, offset - SCAN_PAGE);
  }

  const { events, truncated } = fitToCeiling(collected, tokenCeiling);

  return {
    events,
    coverage: {
      fromEventIndex: events[0]?.index ?? 0,
      toEventIndex: events[events.length - 1]?.index ?? 0,
      mode,
      // Not finding the boundary is itself a form of not seeing the whole turn, so it reports as
      // truncation rather than as a silently partial window.
      truncated: truncated || !boundaryFound,
    },
    // From the events the digest will be shown, not from the whole turn: a file whose edit fell
    // in the dropped middle is not one the summarizer can say anything about.
    filesTouched: filesTouchedIn(events, options.project),
  };
}

/**
 * Index of the last event a PERSON wrote, or -1.
 *
 * Not the last `user` event, which is what this asked for originally and is almost never the
 * same thing: both harnesses record tool results as user lines, so the answer was reliably the
 * tail of a tool loop and the window was the two or three events after it. See `humanTurns.ts`.
 *
 * Reads the `humanTurn` flag the adapter set rather than asking the text again: only the adapter
 * still holds the raw line, and some of what marks a line as the harness's -- Claude's `isMeta` --
 * is not in the text at all.
 */
function lastHumanIndex(events: readonly ActivityEvent[]): number {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i]!.humanTurn === true) return i;
  }
  return -1;
}

/**
 * Drop from the MIDDLE, never from either end.
 *
 * The two ends are the two things a digest cannot be written without: the user's request at the
 * front and the agent's most recent work at the back. A tail-only window loses the question; a
 * head-only window loses the answer.
 */
function fitToCeiling(
  events: readonly ActivityEvent[],
  tokenCeiling: number,
): { events: ActivityEvent[]; truncated: boolean } {
  const budget = tokenCeiling * CHARS_PER_TOKEN;
  const sizes = events.map(eventChars);
  const totalChars = sizes.reduce((sum, size) => sum + size, 0);
  if (totalChars <= budget) return { events: [...events], truncated: false };

  const head: ActivityEvent[] = [];
  const tail: ActivityEvent[] = [];
  let used = 0;
  let low = 0;
  let high = events.length - 1;
  // Alternate outward-in from both ends so the head and the tail get roughly half each,
  // whichever side happens to carry the larger events.
  while (low <= high) {
    const takeTail = tail.length < head.length;
    const pick = takeTail ? high : low;
    const size = sizes[pick]!;
    if (used + size > budget) break;
    used += size;
    if (takeTail) {
      tail.unshift(events[pick]!);
      high -= 1;
    } else {
      head.push(events[pick]!);
      low += 1;
    }
  }
  return { events: [...head, ...tail], truncated: true };
}

/**
 * What this event will cost in the prompt, measured by rendering it.
 *
 * The rendered size, not the raw one, because the two differ by orders of magnitude: the prompt
 * caps a tool result at a few hundred characters, and budgeting against the megabyte it came
 * from would drop the middle of a turn to save bytes that were never going to be sent.
 */
function eventChars(event: ActivityEvent): number {
  // Floor, so a page of empty-bodied machinery lines still costs something and cannot make the
  // estimate claim a 10,000-event window fits.
  return Math.max(renderEvent(event).length, 32);
}
