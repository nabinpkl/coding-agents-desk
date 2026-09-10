/**
 * Turning "this row in the panel" into "this many messages back, and it says this", and finding
 * the row when the reader named no row at all.
 *
 * The panel addresses a transcript line by the id the event index gave it,
 * `claude:<sessionId>:line:<rawIndex>`. The rewind picker addresses a message by how far back from
 * the newest it is, and proves it by what the row says. Neither can be derived from the other
 * without reading the transcript, so this is where the transcript gets read -- and it is read
 * through the event index, never the file.
 *
 * That is the one structural decision in this module. The index is what NUMBERS a transcript:
 * `eventIndexBuild` counts the lines that parse into an event and mints `line:<n>` from that count.
 * A second reader that opened the file and counted its own lines would be a second copy of that
 * rule, agreeing until the day something stopped parsing, and the failure would be an anchor
 * quietly off by one -- a fork that starts before the wrong message and looks exactly like a fork
 * that worked. Reading through the index also means the ids only ever have one author.
 *
 * The cost went the same way rather than against it. Measured on an 80MB transcript, warm: reading
 * the whole file and parsing it is about 300ms EVERY time it is asked, while the index pays about
 * 375ms once and answers from byte offsets in single-digit milliseconds after -- and the panel has
 * usually already built it, because it is the same index the session's transcript is served from.
 * A file genuinely cold on disk was once seen at fifteen seconds; that is the disk rather than the
 * parse, both paths pay it, and only this one pays it once.
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
import {
  acquireIndex,
  ensureIndexed,
  getEventCount,
  readEvents,
  releaseIndex,
} from "@/transcripts/event-index/eventIndex";

/** Where a message sits, said the way the rewind picker is addressed. */
export interface MessageAnchor {
  /** How many messages back from the newest, counting the newest as 1. */
  fromEnd: number;
  /** What that message says, which is what proves the picker landed on the right row. */
  text: string;
}

export class MessageAnchorError extends Error {}

/**
 * How many events are read at a time.
 *
 * Walking back from the end, the answer is almost always in the first page: what sits between a
 * person's last message and the end of the transcript is one turn, and a turn is tool calls and
 * their results. Counting forward from an anchor it is a page size and nothing more -- the whole
 * range gets read either way, and this only decides how many reads that takes. A page too small
 * costs another read; a page too large holds more of the file in memory than the count needs.
 */
const MESSAGE_PAGE = 256;

/**
 * The raw line index an event id names, for a session that must be the one addressed.
 *
 * The session is checked rather than ignored because an id carries one: a panel that sent the row
 * it was looking at while the reader had moved to another session would otherwise anchor into a
 * transcript nobody asked about, and the count would be perfectly valid nonsense.
 */
export function lineFromEventId(eventId: string, sessionId: string): number {
  const match = /^([a-z]+):(.+):line:(\d+)$/.exec(eventId);
  if (!match) throw new MessageAnchorError(`"${eventId}" is not an event id`);
  if (match[1] !== "claude") throw new MessageAnchorError("only a claude event can be forked from");
  if (match[2]!.toLowerCase() !== sessionId.toLowerCase()) {
    throw new MessageAnchorError("that event belongs to a different session");
  }
  return Number(match[3]);
}

/**
 * Where the message on `line` sits among the transcript's messages.
 *
 * Two reads rather than one pass: the row itself, which either is a message somebody wrote or is
 * the refusal, and then everything after it, which is only ever counted. Nothing before the anchor
 * is read at all, and for the rows a reader actually forks from -- the recent ones -- that is most
 * of the file skipped.
 */
export async function anchorAtLine(
  sessionId: string,
  transcriptPath: string,
  line: number,
): Promise<MessageAnchor> {
  // Held across both reads, so a page read from somewhere else cannot drop the index between the
  // row and the count of what follows it.
  acquireIndex("claude", sessionId);
  try {
    await ensureIndexed("claude", sessionId, transcriptPath);
    const total = getEventCount("claude", sessionId, "raw");
    const [target] = await readEvents("claude", sessionId, transcriptPath, line, 1);
    // Covers a line past the end and a line that is a tool result, an assistant turn or a harness
    // envelope, which are one refusal because they are one mistake: the picker has no such entry.
    if (!target || target.humanTurn !== true) {
      throw new MessageAnchorError("that line is not a message somebody wrote");
    }
    let after = 0;
    for (let offset = line + 1; offset < total; offset += MESSAGE_PAGE) {
      const page = await readEvents(
        "claude",
        sessionId,
        transcriptPath,
        offset,
        Math.min(MESSAGE_PAGE, total - offset),
      );
      for (const event of page) if (event.humanTurn === true) after += 1;
    }
    // The newest message is one back from the end, not none, which is what the picker's opening
    // selection means: it starts BELOW the newest, on `(current)`.
    return { fromEnd: after + 1, text: messageText(target) };
  } finally {
    releaseIndex("claude", sessionId);
  }
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
 */
export async function lastHumanMessage(
  sessionId: string,
  transcriptPath: string,
): Promise<{ eventId: string; text: string } | null> {
  // Held for the length of the walk, so a page read in the middle of it cannot drop the index
  // this is walking backwards through.
  acquireIndex("claude", sessionId);
  try {
    await ensureIndexed("claude", sessionId, transcriptPath);
    let end = getEventCount("claude", sessionId, "raw");
    while (end > 0) {
      const offset = Math.max(0, end - MESSAGE_PAGE);
      const page = await readEvents("claude", sessionId, transcriptPath, offset, end - offset);
      for (let at = page.length - 1; at >= 0; at -= 1) {
        const event = page[at]!;
        if (event.humanTurn !== true) continue;
        const text = messageText(event);
        if (text) return { eventId: event.id, text };
      }
      end = offset;
    }
    return null;
  } finally {
    releaseIndex("claude", sessionId);
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
 * The backward walk is the expensive half and only for a session that never compacted, which is
 * the one case it reads the whole index. Measured in this module's header: a full pass over an
 * 80MB transcript is about 300ms warm, paid once per click on a menu item, against a reader who
 * asked for it. A compacted session stops at its newest boundary, which for an active one is near
 * the end.
 */
export async function lastCompactionMessage(
  sessionId: string,
  transcriptPath: string,
): Promise<{ eventId: string; text: string } | null> {
  acquireIndex("claude", sessionId);
  try {
    await ensureIndexed("claude", sessionId, transcriptPath);
    const total = getEventCount("claude", sessionId, "raw");
    const compaction = await newestCompaction(sessionId, transcriptPath, total);
    if (compaction === null) return null;
    // Forward from the boundary rather than from the summary that follows it: both carry the same
    // block, and starting at whichever came first cannot skip a message that sits between them.
    for (let offset = compaction + 1; offset < total; offset += MESSAGE_PAGE) {
      const page = await readEvents(
        "claude",
        sessionId,
        transcriptPath,
        offset,
        Math.min(MESSAGE_PAGE, total - offset),
      );
      for (const event of page) {
        if (event.humanTurn !== true) continue;
        const text = messageText(event);
        // Same skip `lastHumanMessage` makes: an anchor with no prose is one the picker could
        // only be walked to blind, and this repository does not walk blind.
        if (text) return { eventId: event.id, text };
      }
    }
    return null;
  } finally {
    releaseIndex("claude", sessionId);
  }
}

/** The index of the newest event carrying a compaction block, or null when the session has none. */
async function newestCompaction(
  sessionId: string,
  transcriptPath: string,
  total: number,
): Promise<number | null> {
  let end = total;
  while (end > 0) {
    const offset = Math.max(0, end - MESSAGE_PAGE);
    const page = await readEvents("claude", sessionId, transcriptPath, offset, end - offset);
    for (let at = page.length - 1; at >= 0; at -= 1) {
      // The one thing both records a compaction writes have in common, and the one the panel
      // already draws its banner from, so this asks the same question the feed answers.
      if (page[at]!.blocks.some((block) => block.kind === "compaction")) return offset + at;
    }
    end = offset;
  }
  return null;
}
