/**
 * Turning "this row in the panel" into "this many messages back, and it says this", and finding
 * the row when the reader named no row at all.
 *
 * The panel addresses a transcript line by the id its page gave it,
 * `claude:<sessionId>:at:<byte>`: the byte the line starts at, which names it without anything
 * above it having been read. The rewind picker addresses a message by how far back from the newest
 * it is, and proves it by what the row says. Neither can be derived from the other without reading
 * the transcript, so this is where the transcript gets read -- through the same page reads the
 * panel is served from, so the rows counted here are parsed by the one rule that made the ids.
 *
 * Every read here starts at a position and walks only as far as its question: back from the end
 * for the newest message or compaction, forward from the anchor for what follows it. For the rows
 * a reader actually forks from -- the recent ones -- that is a page or two, never the file.
 *
 * Two things make the translation less obvious than it sounds, and both are why the panel is not
 * asked to do it:
 *
 * - **The picker counts MESSAGES; the id counts LINES.** A transcript line is a tool result, an
 *   attachment, a title record or a person speaking, and only the last of those is an entry in the
 *   picker. `isHumanTurnStart` is this repository's answer to which is which, and it carries a
 *   scar: a summarizer once read a tool result as the person speaking because it tested
 *   `type === "user"` alone. It is asked once, in the adapter, and rides every event as
 *   `humanTurn`; this module reads that flag rather than asking again.
 * - **The panel may be looking at a different set.** It renders in file order, so a session that
 *   has been rewound before shows its abandoned turns alongside its live ones, while the picker
 *   lists only the live conversation. Counting here does not make that agree -- nothing can --
 *   which is exactly why the count travels with the text that has to match it.
 */
import { isSaidText } from "@agentdesk/agent-feed-wire";
import {
  completeEnd,
  isLineStart,
  parsedLinesBetween,
  readPageBefore,
} from "@/transcripts/transcript-reads/transcriptPages";
/** Where a message sits, said the way the rewind picker is addressed. */
export interface MessageAnchor {
  /** How many messages back from the newest, counting the newest as 1. */
  fromEnd: number;
  /** What that message says, which is what proves the picker landed on the right row. */
  text: string;
}

export class MessageAnchorError extends Error {}

/** How many rows one step of a backward walk reads. A page too small costs another read. */
const MESSAGE_PAGE = 256;

/**
 * The position an event id names, for a session that must be the one addressed.
 *
 * The session is checked rather than ignored because an id carries one: a panel that sent the row
 * it was looking at while the reader had moved to another session would otherwise anchor into a
 * transcript nobody asked about, and the count would be perfectly valid nonsense.
 */
export function positionFromEventId(eventId: string, sessionId: string): number {
  const match = /^([a-z]+):(.+):at:(\d+)$/.exec(eventId);
  if (!match) throw new MessageAnchorError(`"${eventId}" is not an event id`);
  if (match[1] !== "claude") throw new MessageAnchorError("only a claude event can be forked from");
  if (match[2]!.toLowerCase() !== sessionId.toLowerCase()) {
    throw new MessageAnchorError("that event belongs to a different session");
  }
  return Number(match[3]);
}

/**
 * Where the message at `position` sits among the transcript's messages.
 *
 * One forward read from the row to the end: the row itself, which either is a message somebody
 * wrote or is the refusal, and then everything after it, which is only ever counted. Nothing
 * before the anchor is read at all.
 */
export async function anchorAtPosition(
  sessionId: string,
  transcriptPath: string,
  position: number,
): Promise<MessageAnchor> {
  const end = await completeEnd(transcriptPath);
  // A position inside a line would read from the middle of one; checked rather than trusted, since
  // the id came over the wire.
  const lines = position < end && await isLineStart(transcriptPath, position)
    ? await parsedLinesBetween("claude", transcriptPath, position, end)
    : [];
  const target = lines[0];
  // Covers a position past the end, one inside a line, and a line that is a tool result, an
  // assistant turn or a harness envelope, which are one refusal because they are one mistake: the
  // picker has no such entry.
  if (!target || target.position !== position || target.result.event.humanTurn !== true) {
    throw new MessageAnchorError("that line is not a message somebody wrote");
  }
  let after = 0;
  for (const line of lines.slice(1)) if (line.result.event.humanTurn === true) after += 1;
  // The newest message is one back from the end, not none, which is what the picker's opening
  // selection means: it starts BELOW the newest, on `(current)`.
  return { fromEnd: after + 1, text: messageText(target.result.event) };
}

/**
 * The newest message a person wrote, or null when nobody has written one with prose in it.
 *
 * Here so that forking from the last thing you said does not mean scrolling to find it. A long
 * turn puts a person's last message hundreds of rows above the bottom of the transcript, and the
 * row menu offering the fork is ON that row -- so the affordance was furthest away exactly when
 * the transcript was longest.
 *
 * A message with no prose is skipped rather than returned. The text is not decoration: the rewind
 * picker is driven by matching what its rows say, so an anchor with nothing to match on is one the
 * fork could only reach by counting blind, which is what this repository does not do.
 *
 * `said` also skips a message that only runs a slash command (`isSaidText`), and `before` starts the
 * walk at a position rather than the end. The panel's user bar asks both ways: it names the last
 * thing the reader said above the rows it holds, so it asks from the start of those rows and
 * passes over a `/compact` to the message before it. Asked from the end without `said`, a session
 * whose newest message was `/compact` answered with that, the bar refused it, and showed nothing.
 * A walk back stops at the first match, so its cost is the distance to the message, never the file.
 */
export async function lastHumanMessage(
  sessionId: string,
  transcriptPath: string,
  { said = false, before = null }: { said?: boolean; before?: number | null } = {},
): Promise<{ eventId: string; text: string } | null> {
  let from = before;
  for (;;) {
    const page = await readPageBefore("claude", sessionId, transcriptPath, from, MESSAGE_PAGE, "raw");
    for (let at = page.events.length - 1; at >= 0; at -= 1) {
      const event = page.events[at]!;
      if (event.humanTurn !== true) continue;
      const text = messageText(event);
      if (text && (!said || isSaidText(text))) return { eventId: event.id, text };
    }
    if (page.windowStart === 0) return null;
    from = page.windowStart;
  }
}

/** What the picker would show for this message: its prose, and only its prose. */
function messageText(parsed: { blocks: readonly { kind: string; text?: string }[] }): string {
  for (const block of parsed.blocks) {
    if (block.kind !== "text") continue;
    const text = block.text?.trim();
    if (text) return text;
  }
  return "";
}

/**
 * The first message a person wrote after the session's newest compaction, or null when there is
 * no compaction or nothing has been said since one.
 *
 * This is what "fork from the last compaction" resolves to, and the indirection is the whole
 * point: a compaction is not a row the rewind picker offers. Claude's own filter drops it twice
 * over -- the boundary is a `system` record and the summary carries `isCompactSummary` -- so the
 * nearest point a fork can actually be moved to is the first thing said after it. Rewinding there
 * restores the conversation to just before that message, which is the compacted context and
 * nothing that followed it.
 *
 * Returning null when nothing has been said since is not a failure to report as one. Every
 * `compact_boundary` is written with `parentUuid: null`, so the CLI's own chain walk stops there
 * and a fork already begins at the last compaction; with no message after it, an ordinary fork IS
 * this, and there is nothing to move.
 *
 * The backward walk reads the whole file only for a session that never compacted; a compacted one
 * stops at its newest boundary, which for an active session is near the end.
 */
export async function lastCompactionMessage(
  sessionId: string,
  transcriptPath: string,
): Promise<{ eventId: string; text: string } | null> {
  const compaction = await newestCompaction(sessionId, transcriptPath);
  if (compaction === null) return null;
  // Forward from the boundary rather than from the summary that follows it: both carry the same
  // block, and starting at whichever came first cannot skip a message that sits between them.
  const end = await completeEnd(transcriptPath);
  for (const line of await parsedLinesBetween("claude", transcriptPath, compaction, end)) {
    const event = line.result.event;
    if (event.humanTurn !== true) continue;
    const text = messageText(event);
    // Same skip `lastHumanMessage` makes: an anchor with no prose is one the picker could only be
    // walked to blind, and this repository does not walk blind.
    if (text) return { eventId: `claude:${sessionId}:at:${line.position}`, text };
  }
  return null;
}

/** The position of the newest row carrying a compaction block, or null when there is none. */
async function newestCompaction(sessionId: string, transcriptPath: string): Promise<number | null> {
  let before: number | null = null;
  for (;;) {
    const page = await readPageBefore("claude", sessionId, transcriptPath, before, MESSAGE_PAGE, "raw");
    for (let at = page.events.length - 1; at >= 0; at -= 1) {
      // The one thing both records a compaction writes have in common, and the one the panel
      // already draws its banner from, so this asks the same question the feed answers.
      if (page.events[at]!.blocks.some((block) => block.kind === "compaction")) return page.events[at]!.index;
    }
    if (page.windowStart === 0) return null;
    before = page.windowStart;
  }
}
