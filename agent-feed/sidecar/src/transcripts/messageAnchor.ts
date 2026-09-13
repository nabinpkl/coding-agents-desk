/**
 * Turning "this row in the panel" into "this many messages back, and it says this", and
 * finding the row when the reader named no row at all.
 *
 * The panel addresses a transcript line by the id the event index gave it,
 * `claude:<sessionId>:line:<rawIndex>`. The rewind picker addresses a message by how far back from
 * the newest it is, and proves it by what the row says. Neither can be derived from the other
 * without reading the transcript, so this is where the transcript gets read -- through the file
 * for the question that has to count from the beginning, and through the event index for the one
 * that only has to look at the end.
 *
 * Two things make the translation less obvious than it sounds, and both are why the panel is not
 * asked to do it:
 *
 * - **The picker counts MESSAGES; the id counts LINES.** A transcript line is a tool result, an
 *   attachment, a title record or a person speaking, and only the last of those is an entry in the
 *   picker. `isHumanTurnStart` is this repository's answer to which is which, and it carries a
 *   scar: a summarizer once read a tool result as the person speaking because it tested
 *   `type === "user"` alone.
 * - **The panel may be looking at a different set.** It renders in file order, so a session that
 *   has been rewound before shows its abandoned turns alongside its live ones, while the picker
 *   lists only the live conversation. Counting here does not make that agree -- nothing can --
 *   which is exactly why the count travels with the text that has to match it.
 */
import { claudeAdapter } from "@/transcripts/claude/claudeTranscript";
import {
  acquireIndex,
  ensureIndexed,
  getEventCount,
  readEvents,
  releaseIndex,
} from "@/transcripts/event-index/eventIndex";
import { isHumanTurnStart } from "@/transcripts/humanTurns";

/** Where a message sits, said the way the rewind picker is addressed. */
export interface MessageAnchor {
  /** How many messages back from the newest, counting the newest as 1. */
  fromEnd: number;
  /** What that message says, which is what proves the picker landed on the right row. */
  text: string;
}

export class MessageAnchorError extends Error {}

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
 * Reads the whole file, unlike `lastHumanMessage` below, because the question is different: this
 * one counts the messages BEFORE a given row, so there is no tail to stop at and the index's byte
 * offsets would still leave every line to be parsed. It costs what that implies -- measured at
 * about fifteen seconds on an 80MB transcript -- and it is paid once, after the reader has already
 * confirmed the fork.
 */
export async function anchorAtLine(
  transcriptPath: string,
  line: number,
): Promise<MessageAnchor> {
  let target: string | null = null;
  let after = 0;
  for (const message of humanMessages(await Bun.file(transcriptPath).text())) {
    if (message.rawIndex === line) {
      target = message.text;
      after = 0;
      continue;
    }
    if (target !== null) after += 1;
  }
  if (target === null) {
    throw new MessageAnchorError("that line is not a message somebody wrote");
  }
  // The newest message is one back from the end, not none, which is what the picker's opening
  // selection means: it starts BELOW the newest, on `(current)`.
  return { fromEnd: after + 1, text: target };
}

/**
 * How many events are read at a time, walking backwards.
 *
 * The answer is almost always in the first page: what sits between a person's last message and the
 * end of the transcript is one turn, and a turn is tool calls and their results. A page big enough
 * to hold a long one costs a few hundred KB of the file, and a page too small only costs another
 * read.
 */
const MESSAGE_SEARCH_PAGE = 256;

/**
 * The newest message a person wrote, or null when nobody has written one with prose in it.
 *
 * Here so that forking from the last thing you said does not mean scrolling to find it. A long
 * turn puts a person's last message hundreds of rows above the bottom of the transcript, and the
 * row menu offering the fork is ON that row -- so the affordance was furthest away exactly when
 * the transcript was longest.
 *
 * Read through the event index rather than off the file, unlike everything else here, and the
 * reason is measured: parsing an 80MB transcript end to end takes about fifteen seconds, which is
 * a menu that does nothing for fifteen seconds. The index reads the tail by byte offset instead,
 * and it is the same index the panel builds to show the session at all -- so a session anybody is
 * reading answers in milliseconds, and one nobody is pays the scan the reader was about to pay
 * anyway. It also mints the id, which is the other half of the point: `eventIndexBuild` numbers
 * the lines that parse into an event, and an id built anywhere else is a second copy of that rule.
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
      const offset = Math.max(0, end - MESSAGE_SEARCH_PAGE);
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

/**
 * Every message a person wrote in the file, in order, numbered the way an event id numbers it.
 *
 * That number is NOT a position in the file. The event index numbers the lines that PARSE into an
 * event (`eventIndexBuild.emitParsedRaw`), and the id it mints carries that count -- so the two
 * agree only as long as nothing unparseable sits between them. Today they always agree, because a
 * Claude line that is not blank always parses into something. Counting it here rather than
 * trusting that is what stops one stray blank line shifting every anchor after it.
 */
function* humanMessages(contents: string): Generator<{ rawIndex: number; text: string }> {
  let rawIndex = -1;
  for (const raw of contents.split("\n")) {
    if (!raw) continue;
    const parsed = claudeAdapter.processLine(raw)?.event;
    if (!parsed) continue;
    rawIndex += 1;
    if (!isHumanTurnStart(parsed)) continue;
    yield { rawIndex, text: messageText(parsed) };
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
